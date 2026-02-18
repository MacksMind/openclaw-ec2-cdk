import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dlm from 'aws-cdk-lib/aws-dlm';
import { Construct } from 'constructs';

export class OpenclawCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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

      // Wait for the EBS data volume to attach
      'while [ ! -e /dev/xvdf ]; do echo "Waiting for EBS volume..."; sleep 2; done',

      // Format if new (check for existing filesystem)
      'if ! blkid /dev/xvdf; then mkfs.ext4 /dev/xvdf; fi',

      // Mount the data volume
      'mkdir -p /home/ubuntu/.openclaw',
      'mount /dev/xvdf /home/ubuntu/.openclaw',
      'chown ubuntu:ubuntu /home/ubuntu/.openclaw',

      // Persist mount across reboots
      'echo "/dev/xvdf /home/ubuntu/.openclaw ext4 defaults,nofail 0 2" >> /etc/fstab',
    );

    // --- EC2 Instance ---
    const instance = new ec2.Instance(this, 'Worker', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.lookup({
        name: 'ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*',
        owners: ['099720109477'], // Canonical
      }),
      securityGroup,
      role,
      userData,
      userDataCausesReplacement: false,
    });

    // --- Persistent EBS Volume (same AZ as instance) ---
    const dataVolume = new ec2.Volume(this, 'DataVolume', {
      availabilityZone: instance.instanceAvailabilityZone,
      size: cdk.Size.gibibytes(1),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
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

    // --- CloudFormation Outputs ---
    new cdk.CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'EC2 instance ID for SSM commands',
    });
  }
}
