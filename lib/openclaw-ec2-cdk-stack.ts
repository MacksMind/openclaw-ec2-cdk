import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dlm from 'aws-cdk-lib/aws-dlm';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';

export class OpenclawCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const enableWebhookContext = this.node.tryGetContext('enableWebhook');
    const enableWebhook = enableWebhookContext === undefined
      ? true
      : String(enableWebhookContext).toLowerCase() !== 'false';

    // --- VPC ---
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
      natGateways: 0,
    });

    // --- Security Group ---
    const securityGroup = new ec2.SecurityGroup(this, 'InstanceSg', {
      vpc,
      description: 'OpenClaw worker - egress only',
      allowAllOutbound: true,
    });

    // --- IAM Role ---
    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // --- User Data ---
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euxo pipefail',

      // Install Node 24 via NodeSource
      'curl -fsSL https://deb.nodesource.com/setup_24.x | bash -',
      'apt-get install -y nodejs',

      // Install openclaw globally
      'npm install -g openclaw@latest',

      // Find the EBS data volume (Nitro instances use NVMe — /dev/xvdf maps to /dev/nvme*n1)
      'DATA_DEV=""',
      'for i in $(seq 1 30); do',
      '  DATA_DEV=$(lsblk -dno NAME,SIZE | awk \'$2 == "2G" {print "/dev/"$1}\' | grep -v nvme0)',
      '  [ -n "$DATA_DEV" ] && break',
      '  echo "Waiting for EBS data volume... ($i)"',
      '  sleep 2',
      'done',
      '[ -z "$DATA_DEV" ] && { echo "ERROR: Data volume not found"; exit 1; }',
      'echo "Found data volume at $DATA_DEV"',

      // Format if new (check for existing filesystem)
      'if ! blkid "$DATA_DEV"; then mkfs.ext4 "$DATA_DEV"; fi',

      // Mount temporarily to seed the volume with the existing home dir contents
      'mkdir -p /mnt/home-seed',
      'mount "$DATA_DEV" /mnt/home-seed',

      // Only seed on first use (guard with a marker file)
      'if [ ! -f /mnt/home-seed/.volume-initialized ]; then',
      '  cp -a /home/ubuntu/. /mnt/home-seed/',
      '  touch /mnt/home-seed/.volume-initialized',
      'fi',

      'umount /mnt/home-seed',

      // Now mount the volume at /home/ubuntu — its contents replace the tmpfs view
      'mount "$DATA_DEV" /home/ubuntu',

      // Persist mount across reboots using UUID
      'DATA_UUID=$(blkid -s UUID -o value "$DATA_DEV")',
      'echo "UUID=$DATA_UUID /home/ubuntu ext4 defaults,nofail 0 2" >> /etc/fstab',
    );

    // --- EC2 Instance ---
    const instance = new ec2.Instance(this, 'Worker', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.lookup({
        name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*',
        owners: ['099720109477'], // Canonical
      }),
      securityGroup,
      role,
      userData,
      userDataCausesReplacement: false,
      blockDevices: [
        {
          deviceName: '/dev/sda1',
          volume: ec2.BlockDeviceVolume.ebs(20, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
    });

    // --- Persistent EBS Volume (same AZ as instance) ---
    const dataVolume = new ec2.Volume(this, 'DataVolume', {
      availabilityZone: instance.instanceAvailabilityZone,
      size: cdk.Size.gibibytes(2),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new ec2.CfnVolumeAttachment(this, 'DataVolumeAttachment', {
      instanceId: instance.instanceId,
      volumeId: dataVolume.volumeId,
      device: '/dev/xvdf',
    });

    // --- DLM Snapshot Policy (every 4 hours, 7-day retention) ---
    const dlmRole = new iam.Role(this, 'DlmRole', {
      assumedBy: new iam.ServicePrincipal('dlm.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSDataLifecycleManagerServiceRole'),
      ],
    });

    new dlm.CfnLifecyclePolicy(this, 'SnapshotPolicy', {
      description: 'OpenClaw data volume snapshots every 4 hours',
      state: 'ENABLED',
      executionRoleArn: dlmRole.roleArn,
      policyDetails: {
        resourceTypes: ['VOLUME'],
        targetTags: [{ key: 'openclaw:backup', value: 'true' }],
        schedules: [
          {
            name: 'Every4Hours',
            createRule: {
              interval: 4,
              intervalUnit: 'HOURS',
              times: ['00:00'],
            },
            retainRule: {
              count: 42, // 6 per day * 7 days
            },
            copyTags: true,
          },
        ],
      },
    });

    // Tag the data volume for DLM
    cdk.Tags.of(dataVolume).add('openclaw:backup', 'true');

    let api: apigw.LambdaRestApi | undefined;
    if (enableWebhook) {
      // --- Webhook Forwarder (API Gateway → Lambda → EC2 ports 18789/3334) ---
      const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
        vpc,
        description: 'OpenClaw webhook forwarder Lambda',
      });

      // Allow Lambda to reach the EC2 on required webhook ports (nothing else inbound)
      securityGroup.addIngressRule(
        ec2.Peer.securityGroupId(lambdaSg.securityGroupId),
        ec2.Port.tcp(18789),
        'Webhook forwarder Lambda',
      );
      securityGroup.addIngressRule(
        ec2.Peer.securityGroupId(lambdaSg.securityGroupId),
        ec2.Port.tcp(3334),
        'Webhook forwarder Lambda voice webhook',
      );

      const forwarder = new lambda.Function(this, 'WebhookForwarder', {
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        allowPublicSubnet: true,
        securityGroups: [lambdaSg],
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        timeout: cdk.Duration.seconds(30),
        environment: {
          EC2_PRIVATE_IP: instance.instancePrivateIp,
        },
        code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  const qs = event.queryStringParameters
    ? '?' + new URLSearchParams(event.queryStringParameters).toString()
    : '';
  const targetPort = event.path?.endsWith('/voice/webhook') ? '3334' : '18789';
  const method = event.httpMethod ?? 'GET';
  const res = await fetch(
    \`http://\${process.env.EC2_PRIVATE_IP}:\${targetPort}\${event.path}\${qs}\`,
    {
      method,
      headers: event.headers ?? {},
      body: ['GET', 'HEAD'].includes(method) ? undefined : (event.body ?? undefined),
    }
  );
  return { statusCode: res.status, body: await res.text() };
};
      `),
      });

      api = new apigw.LambdaRestApi(this, 'WebhookApi', {
        handler: forwarder,
        proxy: true,
      });
    }

    // --- CloudFormation Outputs ---
    new cdk.CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'EC2 instance ID for SSM commands',
    });

    if (api) {
      new cdk.CfnOutput(this, 'WebhookUrl', {
        value: api.url,
        description: 'API Gateway URL — append your webhook path (e.g. hooks/pubsub)',
      });
    }
  }
}
