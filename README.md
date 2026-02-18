# openclaw-cdk

CDK stack for deploying the OpenClaw worker to EC2.

## Prerequisites

- Node.js and npm
- AWS CDK CLI (`npm install -g aws-cdk`)
- AWS credentials configured
- [SSM Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)

## CDK Commands

* `npm run build`   compile typescript to js
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template

## Operator Runbook

After deploying, grab the instance ID from the stack output:

```
aws cloudformation describe-stacks --stack-name OpenClawStack \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' --output text
```

### Connect via SSM

```
aws ssm start-session --target <InstanceId>
```

### Port forward the web UI

```
aws ssm start-session --target <InstanceId> \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["18789"],"localPortNumber":["18789"]}'
```

Then open `http://localhost:PORT` in your browser.

### Install / update openclaw

```
aws ssm start-session --target <InstanceId>
sudo su - ubuntu
sudo npm install -g openclaw@latest
```
