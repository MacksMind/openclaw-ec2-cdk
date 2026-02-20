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

test('Instance security group allows Lambda on ports 18789 and 3334', () => {
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: Match.arrayWith([
      Match.objectLike({
        IpProtocol: 'tcp',
        FromPort: 18789,
        ToPort: 18789,
      }),
      Match.objectLike({
        IpProtocol: 'tcp',
        FromPort: 3334,
        ToPort: 3334,
      }),
    ]),
  });
});

test('Lambda forwarder routes /voice/webhook to port 3334', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp('voice/webhook'),
    },
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp("'3334'"),
    },
  });
});

test('Lambda forwarder passes through incoming request headers', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      ZipFile: Match.stringLikeRegexp('headers: event.headers \\\?\\\? \\\{\\\}'),
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

test('WebhookUrl is output', () => {
  template.hasOutput('WebhookUrl', {});
});

test('Lambda and API are not created when enableWebhook=false', () => {
  disabledTemplate.resourceCountIs('AWS::Lambda::Function', 0);
  disabledTemplate.resourceCountIs('AWS::ApiGatewayV2::Api', 0);
});

test('WebhookUrl is not output when enableWebhook=false', () => {
  expect(disabledTemplate.findOutputs('WebhookUrl')).toEqual({});
});
