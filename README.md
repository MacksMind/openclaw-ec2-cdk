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

## What This Stack Creates

### Always created

- VPC (`10.0.0.0/16`) with 2 public subnets across AZs and no NAT gateway
- EC2 worker (`t4g.large`, Ubuntu 24.04 arm64) with `20 GB gp3` root volume
- Worker security group (egress-only baseline)
- EC2 IAM role with `AmazonSSMManagedInstanceCore`
- Persistent data EBS volume (`4 GB gp3`, encrypted, retained) attached to the worker at `/dev/xvdf`
- DLM lifecycle policy + DLM service role for 4-hour snapshots (7-day retention via count)
- Data volume backup tag: `openclaw:backup=true`
- CloudFormation output: `InstanceId`

### Created when `enableWebhook=true`

- Public ALB for voice traffic
- ALB security group allowing inbound `80/tcp`
- Target group forwarding `/voice/*` traffic to worker `3334/tcp`
- Lambda webhook forwarder in the VPC
- Lambda security group
- Worker SG ingress from Lambda SG on `8080/tcp`
- Worker SG ingress from ALB SG on `3334/tcp`
- API Gateway HTTP API with default stage and route `ANY /{proxy+}` to Lambda
- CloudFormation outputs: `WebhookUrl`, `VoiceAlbDnsName`, `VoiceWebhookUrl`

### Additional resources when custom voice domain is configured

If `VOICE_ROOT_DOMAIN` + `VOICE_HOSTED_ZONE_ID` (or equivalent context) are set:

- ACM certificate for the configured voice domain (DNS validated)
- ALB HTTPS listener on `443/tcp`
- HTTP (`80`) listener redirects to HTTPS
- Route53 alias A record for the configured voice subdomain

### Enable webhook infra (Lambda + API Gateway + ALB)

By default, webhook resources are not created. To enable the Lambda forwarder, API Gateway, and voice ALB:

```
npx cdk deploy -c enableWebhook=true
```

Disable again with `-c enableWebhook=false` (or by omitting the flag).

## Cost Estimate (us-east-1, on-demand)

Assumptions: 1x `t4g.large` Linux instance, one public IPv4 address, gp3 root/data volumes, and DLM snapshots every 4 hours with 7-day retention.

Baseline (core stack):

- EC2 (`t4g.large`): ~$49.06/mo
- Public IPv4 address: ~$3.65/mo
- EBS root (`20 GB gp3`): ~$1.60/mo
- EBS data (`4 GB gp3`): ~$0.32/mo
- EBS snapshots (DLM, every 4h, 7-day retention): ~$0.05/mo (incremental, ~1 GB stored)
- Data transfer: minimal (workload-dependent)
- **Baseline total: ~$55/mo**

Additional when webhook resources are enabled (`enableWebhook=true`):

- Application Load Balancer (hourly + low-traffic LCUs): typically ~$18–$23/mo
- API Gateway HTTP API: usage-based (often low at small request volume)
- Lambda forwarder: usage-based (often low at small request volume)
- Extra data transfer and ALB processed bytes: workload-dependent

Optional custom-domain additions:

- ACM public certificate: $0 (AWS-managed public cert)
- Route53 alias record queries: minimal for low traffic
- Hosted zone: $0 if reusing an existing zone; ~$0.50/mo if creating a new zone

- **Typical total with webhook enabled: ~$73–$78+/mo**

Actual costs vary with region, usage, and snapshot churn.

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
  --parameters '{"portNumber":["8080"],"localPortNumber":["8080"]}'
```

Then open `http://localhost:PORT` in your browser.

### Install or update openclaw

`openclaw` is not installed automatically during initialization. Install (or update) it manually:

```
aws ssm start-session --target <InstanceId>
sudo su - ubuntu
sudo npm install -g openclaw@latest
openclaw doctor
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
