# Infrastructure Design Doc: openclaw-cdk

## Overview

**Project:** EC2 instance for running the OpenClaw worker
**Owner:**
**Date:** 2026-02-18
**Status:** Draft

## Motivation

Provision a lightweight EC2 instance to run `openclaw` as a background worker.

## Application

| Question | Answer |
|----------|--------|
| Application type | Worker (long-running daemon) |
| Language / framework | Node 24 |
| Source repo | n/a — installed via `sudo npm install -g openclaw@latest` |
| How is the app installed? | Manual SSH via SSM, then `sudo npm install -g openclaw@latest` |
| Ports the app listens on | Web UI on a local port (accessed via SSM port forwarding, not exposed publicly) |

## Compute

| Question | Answer |
|----------|--------|
| Instance type | t4g.large (ARM/Graviton) |
| AMI / OS | Ubuntu 24.04 LTS (arm64) |
| Root volume size (GB) | Default (8 GB) |
| Additional EBS volumes? | Yes — 4 GB gp3 mounted at /home/ubuntu (persists across instance recreation) |
| EBS data volume protection | RemovalPolicy.RETAIN, deleteOnTermination: false, snapshots every 4 hours via DLM (7-day retention) |
| Number of instances | 1 |
| Auto Scaling needed? | No |

## Networking & Access

| Question | Answer |
|----------|--------|
| VPC | Dedicated VPC (10.0.0.0/16), 2 AZs, public subnets only, no NAT Gateway |
| Public internet access | Outbound only (for npm install, openclaw operations) |
| Inbound ports | None by default (when `enableWebhook=true`: ALB `80/tcp`, worker `3334/tcp` from ALB SG, worker `8080/tcp` from Lambda SG) |
| SSH access | Yes, via SSM Session Manager (no key pair, no port 22) |
| Custom domain | No |
| TLS/SSL certificate | No |
| Load balancer | Optional — public ALB only when `enableWebhook=true` |

## Deployment

| Question | Answer |
|----------|--------|
| Instance provisioning | User data script installs Node 24, seeds persistent EBS volume, then mounts it at /home/ubuntu |
| App installation | Manual — operator SSMs in and runs `sudo npm install -g openclaw@latest` |
| App configuration | Manual — operator configures openclaw after install |
| Updates | Manual — `sudo npm install -g openclaw@latest` again |

## Operations

| Question | Answer |
|----------|--------|
| Logging | CloudWatch agent |
| Monitoring / alarms | Auto-recovery alarm (instance status check) |
| Auto-recovery on failure? | Yes |
| Backup requirements | EBS snapshots every 4 hours via DLM, 7-day retention |

## Security

| Question | Answer |
|----------|--------|
| IAM permissions | SSM Session Manager access |
| Security group | Egress-only (no inbound rules) |

## Cost Estimate

Cost estimate is maintained in [README.md](../README.md) to keep a single source of truth.

## CloudFormation Outputs

| Output | Description |
|--------|-------------|
| InstanceId | EC2 instance ID (used for SSM commands) |

