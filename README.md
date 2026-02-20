# openclaw-ec2-cdk

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

### Temporarily disable webhook infra (Lambda + API Gateway)

By default, webhook resources are enabled. To temporarily skip creating the Lambda forwarder and API Gateway:

```
npx cdk deploy -c enableWebhook=false
```

Re-enable by omitting the flag (or setting `-c enableWebhook=true`).

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

### Update openclaw

`openclaw@latest` is installed automatically on first boot. To update to a newer version:

```
aws ssm start-session --target <InstanceId>
sudo npm install -g openclaw@latest
```

## Twilio voice webhook via ALB

When webhook infrastructure is enabled, the stack now creates a public ALB for voice webhook ingress.

- `VoiceAlbDnsName` output: public ALB DNS name
- `VoiceWebhookUrl` output: prebuilt URL (`http://<alb-dns>/voice/webhook`)

Use `VoiceWebhookUrl` as the Twilio voice webhook URL if you want voice traffic to go through ALB directly.

### Portable configuration for shared repos

Custom domain settings are intentionally not hard-coded in source. Configure them at deploy time via either environment variables or local CDK context.

- Required pair for custom domain/TLS: root domain + hosted zone ID
- Optional: subdomain (defaults to `openclaw-voice`)
- Validation: stack synthesis fails if only one of root domain / zone ID is provided

### Optional custom domain + TLS (recommended)

To create an HTTPS ALB endpoint using Route53 + ACM (without committing zone IDs to git), set env vars only in your shell:

```bash
export VOICE_ROOT_DOMAIN=example.com
export VOICE_HOSTED_ZONE_ID=EXAMPLE
export VOICE_SUBDOMAIN=openclaw-voice
npx cdk deploy OpenClawStack --require-approval never
```

This creates/uses `openclaw-voice.example.com` and updates `VoiceWebhookUrl` to an `https://` URL.

You can also use local context (in `cdk.context.json` or `~/.cdk.json`) if preferred:

```json
{
  "voiceRootDomain": "example.com",
  "voiceHostedZoneId": "EXAMPLE",
  "voiceSubdomain": "openclaw-voice"
}
```

Prefer env vars or uncommitted local context for portability across accounts/environments.
