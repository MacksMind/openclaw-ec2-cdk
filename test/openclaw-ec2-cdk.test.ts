import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { OpenclawCdkStack } from '../lib/openclaw-ec2-cdk-stack';

const createTemplate = (enableWebhook?: boolean): Template => {
  const app = new cdk.App({
    context: {
      'availability-zones:account=111111111111:region=us-east-1': [
        'us-east-1a', 'us-east-1b', 'us-east-1c',
      ],
      'ami:account=111111111111:filters.image-type.0=machine:filters.name.0=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*:filters.state.0=available:owners.0=099720109477:region=us-east-1':
        'ami-00cdb36f35bd8af7d',
      ...(enableWebhook === undefined ? {} : { enableWebhook }),
    },
  });
  const stack = new OpenclawCdkStack(app, 'TestStack', {
    env: { account: '111111111111', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
};

let template: Template;
let disabledTemplate: Template;

beforeAll(() => {
  template = createTemplate();
  disabledTemplate = createTemplate(false);
});

test('Lambda forwarder exists with correct runtime and timeout', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs22.x',
    Timeout: 30,
  });
});

test('Lambda forwarder has EC2_PRIVATE_IP env var', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: {
      Variables: Match.objectLike({
        EC2_PRIVATE_IP: Match.anyValue(),
      }),
    },
  });
});

test('Worker instance is pinned to first public subnet', () => {
  template.hasResourceProperties('AWS::EC2::Instance', {
    SubnetId: {
      Ref: Match.stringLikeRegexp('VpcPublicSubnet1Subnet'),
    },
  });
});

test('Instance security group allows Lambda on port 8080', () => {
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: Match.arrayWith([
      Match.objectLike({
        IpProtocol: 'tcp',
        FromPort: 8080,
        ToPort: 8080,
      }),
    ]),
  });
});

test('Lambda forwarder routes API Gateway traffic to port 8080', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp("const targetPort = '8080'"),
    },
  });
});

test('Lambda forwarder logs exact EC2 response and logs fetch errors', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp('try \\\{'),
    },
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp('console\\.log\\(JSON\\.stringify\\(\\{'),
    },
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp('headers: Object\\.fromEntries\\(res\\.headers\\.entries\\(\\)\\)'),
    },
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp("message: 'EC2 response'[\\s\\S]*targetUrl,"),
    },
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp('catch \\\(error\\\)'),
    },
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp('console\\.error\\(JSON\\.stringify\\(\\{'),
    },
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp('const targetUrl = `http://\\$\\{process\\.env\\.EC2_PRIVATE_IP\\}:\\$\\{targetPort\\}\\$\\{path\\}\\$\\{qs\\}`'),
    },
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp('targetUrl,'),
    },
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp('errorCause: error instanceof Error && \'cause\' in error \\\? String\\(error\\.cause\\) : undefined'),
    },
  });
});

test('Lambda forwarder passes through incoming request headers', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp('const forwardedHeaders = \\\{ \\\.\\\.\\\.\\(event.headers \\\?\\\? \\\{\\\}\\) \\\}'),
    },
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp('headers: forwardedHeaders'),
    },
  });
});

test('Lambda forwarder decodes base64-encoded request bodies', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp("event.isBase64Encoded"),
    },
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp("Buffer.from\\(event.body, 'base64'\\).toString\\(\\)"),
    },
  });
});

test('Lambda forwarder maps query params to X-OpenClaw-* headers', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp('new URLSearchParams\\(rawQs\\)\\.entries\\(\\)'),
    },
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp('const normalizedKey = queryKey\\.charAt\\(0\\)\\.toUpperCase\\(\\)'),
    },
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp("forwardedHeaders\\['X-OpenClaw-' \\+ normalizedKey\\] = queryValue"),
    },
  });
});

test('Lambda forwarder still uses X-OpenClaw-Token header name', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp('X-OpenClaw-'),
    },
  });
});

test('Lambda forwarder strips forwarded query string entirely', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp("const qs = ''"),
    },
  });
});

test('HTTP API with default stage is created', () => {
  template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
    StageName: '$default',
    AutoDeploy: true,
  });
});

test('Public ALB and listener are created for voice traffic', () => {
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
    Port: 80,
    Protocol: 'HTTP',
  });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
    Port: 3334,
    Protocol: 'HTTP',
  });
  template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
    Conditions: Match.arrayWith([
      Match.objectLike({
        Field: 'path-pattern',
        PathPatternConfig: {
          Values: ['/voice/*'],
        },
      }),
    ]),
  });
});

test('WebhookUrl is output', () => {
  template.hasOutput('WebhookUrl', {});
});

test('Voice ALB outputs are present', () => {
  template.hasOutput('VoiceAlbDnsName', {});
  template.hasOutput('VoiceWebhookUrl', {});
});

test('Lambda and API are not created when enableWebhook=false', () => {
  disabledTemplate.resourceCountIs('AWS::Lambda::Function', 0);
  disabledTemplate.resourceCountIs('AWS::ApiGatewayV2::Api', 0);
  disabledTemplate.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
});

test('WebhookUrl is not output when enableWebhook=false', () => {
  expect(disabledTemplate.findOutputs('WebhookUrl')).toEqual({});
});
