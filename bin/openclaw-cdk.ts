#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { OpenclawCdkStack } from '../lib/openclaw-cdk-stack';

const app = new cdk.App();
new OpenclawCdkStack(app, 'OpenClawStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
