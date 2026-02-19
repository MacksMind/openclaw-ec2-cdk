import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { OpenclawCdkStack } from '../lib/openclaw-cdk-stack';

let template: Template;

beforeAll(() => {
  const app = new cdk.App({
    context: {
      'availability-zones:account=111111111111:region=us-east-1': [
        'us-east-1a', 'us-east-1b', 'us-east-1c',
      ],
      'ami:account=111111111111:filters.image-type.0=machine:filters.name.0=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*:filters.state.0=available:owners.0=099720109477:region=us-east-1':
        'ami-00cdb36f35bd8af7d',
    },
  });
  const stack = new OpenclawCdkStack(app, 'TestStack', {
    env: { account: '111111111111', region: 'us-east-1' },
  });
  template = Template.fromStack(stack);
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

test('Instance security group allows Lambda on port 18789', () => {
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: Match.arrayWith([
      Match.objectLike({
        IpProtocol: 'tcp',
        FromPort: 18789,
        ToPort: 18789,
      }),
    ]),
  });
});

test('API Gateway REST API is created', () => {
  template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
});

test('WebhookUrl is output', () => {
  template.hasOutput('WebhookUrl', {});
});
