import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dlm from 'aws-cdk-lib/aws-dlm';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2Targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';

export class OpenclawCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const enableWebhookContext = this.node.tryGetContext('enableWebhook');
    const enableWebhook = enableWebhookContext === undefined
      ? false
      : String(enableWebhookContext).toLowerCase() === 'true';

    const voiceRootDomain = process.env.VOICE_ROOT_DOMAIN
      ?? this.node.tryGetContext('voiceRootDomain');
    const voiceHostedZoneId = process.env.VOICE_HOSTED_ZONE_ID
      ?? this.node.tryGetContext('voiceHostedZoneId');
    const voiceSubdomain = process.env.VOICE_SUBDOMAIN
      ?? this.node.tryGetContext('voiceSubdomain')
      ?? 'openclaw-voice';

    const hasVoiceRootDomain = Boolean(voiceRootDomain);
    const hasVoiceHostedZoneId = Boolean(voiceHostedZoneId);
    if (hasVoiceRootDomain !== hasVoiceHostedZoneId) {
      throw new Error(
        'Voice custom domain config is incomplete. Set both VOICE_ROOT_DOMAIN and VOICE_HOSTED_ZONE_ID (or context keys voiceRootDomain and voiceHostedZoneId), or set neither.',
      );
    }

    const voiceDomainName = voiceRootDomain ? `${voiceSubdomain}.${voiceRootDomain}` : undefined;

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

      // Find the EBS data volume (Nitro instances use NVMe — /dev/xvdf maps to /dev/nvme*n1)
      'DATA_DEV=""',
      'for i in $(seq 1 30); do',
      '  DATA_DEV=$(lsblk -dno NAME,SIZE | awk \'$2 == "4G" {print "/dev/"$1}\' | grep -v nvme0)',
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
    // Pin worker to a deterministic subnet/AZ so retained data volume can be reattached on replacements.
    const workerSubnet = vpc.publicSubnets[0];
    const instance = new ec2.Instance(this, 'Worker', {
      vpc,
      vpcSubnets: { subnets: [workerSubnet] },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.LARGE),
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
      size: cdk.Size.gibibytes(4),
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

    let api: apigwv2.HttpApi | undefined;
    let alb: elbv2.ApplicationLoadBalancer | undefined;
    if (enableWebhook) {
      // --- Public ALB for Twilio voice traffic ---
      const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
        vpc,
        description: 'Public ALB for Twilio voice webhook traffic',
        allowAllOutbound: true,
      });
      albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Public HTTP ingress for Twilio voice webhook');

      // Allow ALB to reach voice webhook port on instance
      securityGroup.addIngressRule(
        ec2.Peer.securityGroupId(albSg.securityGroupId),
        ec2.Port.tcp(3334),
        'ALB to OpenClaw voice webhook',
      );

      alb = new elbv2.ApplicationLoadBalancer(this, 'VoiceAlb', {
        vpc,
        internetFacing: true,
        securityGroup: albSg,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      });

      const voiceTargetGroup = new elbv2.ApplicationTargetGroup(this, 'VoiceAlbTargetGroup', {
        vpc,
        targetType: elbv2.TargetType.INSTANCE,
        protocol: elbv2.ApplicationProtocol.HTTP,
        port: 3334,
        targets: [new elbv2Targets.InstanceTarget(instance)],
        healthCheck: {
          path: '/',
          healthyHttpCodes: '200-499',
        },
      });

      let shouldRedirectHttpToHttps = false;

      if (voiceRootDomain && voiceHostedZoneId && voiceDomainName) {
        const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'VoiceHostedZone', {
          hostedZoneId: voiceHostedZoneId,
          zoneName: voiceRootDomain,
        });

        const certificate = new acm.Certificate(this, 'VoiceAlbCertificate', {
          domainName: voiceDomainName,
          validation: acm.CertificateValidation.fromDns(hostedZone),
        });

        const httpsListener = alb.addListener('VoiceAlbHttpsListener', {
          port: 443,
          protocol: elbv2.ApplicationProtocol.HTTPS,
          certificates: [certificate],
          defaultAction: elbv2.ListenerAction.fixedResponse(404, {
            contentType: 'text/plain',
            messageBody: 'Not Found',
          }),
        });
        httpsListener.addAction('VoicePathHttpsRule', {
          priority: 10,
          conditions: [elbv2.ListenerCondition.pathPatterns(['/voice/*'])],
          action: elbv2.ListenerAction.forward([voiceTargetGroup]),
        });
        shouldRedirectHttpToHttps = true;

        new route53.ARecord(this, 'VoiceAlbAliasRecord', {
          zone: hostedZone,
          recordName: voiceSubdomain,
          target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb)),
        });
      }

      const httpListener = alb.addListener('VoiceAlbHttpListener', shouldRedirectHttpToHttps
        ? {
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultAction: elbv2.ListenerAction.redirect({
              protocol: 'HTTPS',
              port: '443',
              permanent: true,
            }),
          }
        : {
            port: 80,
            protocol: elbv2.ApplicationProtocol.HTTP,
            defaultAction: elbv2.ListenerAction.fixedResponse(404, {
              contentType: 'text/plain',
              messageBody: 'Not Found',
            }),
          });

      if (!shouldRedirectHttpToHttps) {
        httpListener.addAction('VoicePathHttpRule', {
          priority: 10,
          conditions: [elbv2.ListenerCondition.pathPatterns(['/voice/*'])],
          action: elbv2.ListenerAction.forward([voiceTargetGroup]),
        });
      }

      // --- Webhook Forwarder (API Gateway → Lambda → EC2 ports 8080) ---
      const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
        vpc,
        description: 'OpenClaw webhook forwarder Lambda',
      });

      // Allow Lambda to reach the EC2 on required webhook ports (nothing else inbound)
      securityGroup.addIngressRule(
        ec2.Peer.securityGroupId(lambdaSg.securityGroupId),
        ec2.Port.tcp(8080),
        'Webhook forwarder Lambda',
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
  const path = event.rawPath ?? event.path ?? '/';
  const rawQs = event.rawQueryString
    ?? (event.queryStringParameters
      ? new URLSearchParams(event.queryStringParameters).toString()
      : '');
  const qs = '';
  const targetPort = '8080';
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? 'GET';
  const forwardedHeaders = { ...(event.headers ?? {}) };
  for (const [queryKey, queryValue] of new URLSearchParams(rawQs).entries()) {
    const normalizedKey = queryKey.charAt(0).toUpperCase() + queryKey.slice(1);
    forwardedHeaders['X-OpenClaw-' + normalizedKey] = queryValue;
  }
  delete forwardedHeaders['host'];
  const body = event.isBase64Encoded && event.body
    ? Buffer.from(event.body, 'base64').toString()
    : (event.body ?? undefined);
  const targetUrl = \`http://\${process.env.EC2_PRIVATE_IP}:\${targetPort}\${path}\${qs}\`;
  try {
    const res = await fetch(
      targetUrl,
      {
        method,
        headers: forwardedHeaders,
        body: ['GET', 'HEAD'].includes(method) ? undefined : body,
      }
    );
    const responseBody = await res.text();
    console.log(JSON.stringify({
      message: 'EC2 response',
      method,
      targetUrl,
      statusCode: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: responseBody,
    }));
    return { statusCode: res.status, body: responseBody };
  } catch (error) {
    console.error(JSON.stringify({
      message: 'EC2 forwarder error',
      method,
      targetUrl,
      queryString: rawQs,
      errorName: error instanceof Error ? error.name : undefined,
      error: error instanceof Error ? error.message : String(error),
      errorCause: error instanceof Error && 'cause' in error ? String(error.cause) : undefined,
    }));
    throw error;
  }
};
      `),
      });

      api = new apigwv2.HttpApi(this, 'WebhookApi', {
        createDefaultStage: true,
      });

      api.addRoutes({
        path: '/{proxy+}',
        methods: [apigwv2.HttpMethod.ANY],
        integration: new apigwv2Integrations.HttpLambdaIntegration('WebhookIntegration', forwarder),
      });
    }

    // --- CloudFormation Outputs ---
    new cdk.CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'EC2 instance ID for SSM commands',
    });

    if (api) {
      new cdk.CfnOutput(this, 'WebhookUrl', {
        value: `${api.apiEndpoint}/`,
        description: 'HTTP API URL — append your webhook path (e.g. voice/webhook)',
      });
    }

    if (alb) {
      new cdk.CfnOutput(this, 'VoiceAlbDnsName', {
        value: alb.loadBalancerDnsName,
        description: 'Public ALB DNS for Twilio voice webhook traffic',
      });

      new cdk.CfnOutput(this, 'VoiceWebhookUrl', {
        value: voiceDomainName && voiceRootDomain && voiceHostedZoneId
          ? `https://${voiceDomainName}/voice/webhook`
          : `http://${alb.loadBalancerDnsName}/voice/webhook`,
        description: 'Public voice webhook URL via ALB',
      });
    }
  }
}
