#!/usr/bin/env python3
"""
Build the "Connect your AWS account" CloudFormation template that customers run in THEIR account (Phase 12b).

    python3 infra/saas/build-connect-template.py      # → ops-console/api/assets/connect-aws.json

It contains, for the region the stack is created in:
  - OpsConsoleAccess-<region>: the role the console assumes. It trusts ONLY the console's AWS identity
    (ConsolePrincipal) and ONLY with the workspace's ExternalId; its permissions mirror what the console uses on its
    own servers (fixed OpsConsole-* documents on tagged instances, read status/costs, tagged-only power, SSH rules
    and terminals, app settings under /apps/*), nothing broader.
  - OpsConsoleInstance-<region>: an instance profile for the customer's servers (Session Manager + their app settings).
  - Every OpsConsole-* SSM document, generated from the same scripts and parameter definitions that
    infra/ops-console-ssm/deploy.sh publishes, so the two never drift apart.
Deleting the stack removes all of it, which disconnects the console.
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SSM = os.path.join(ROOT, 'infra', 'ops-console-ssm')
OUT = os.path.join(ROOT, 'ops-console', 'api', 'assets', 'connect-aws.json')

src = open(os.path.join(SSM, 'deploy.sh')).read()
params = {m.group(1): json.loads(m.group(2)) for m in re.finditer(r"^([A-Z_]+_PARAMS)='(\{.*?\})'", src, re.S | re.M)}
docs = []
for m in re.finditer(r'^upsert (OpsConsole-[A-Za-z]+) (\S+\.sh) "([^"]*)" (\d+)(?: "\$([A-Z_]+)")?\s*$', src, re.M):
    name, script, desc, timeout, pvar = m.groups()
    docs.append((name, script, desc, timeout, params[pvar] if pvar else None))
if len(docs) < 10:
    sys.exit(f'found only {len(docs)} documents in deploy.sh: the parser needs updating')


def doc_content(script, desc, timeout, p):
    lines = open(os.path.join(SSM, script)).read().splitlines()
    c = {'schemaVersion': '2.2', 'description': desc,
         'mainSteps': [{'action': 'aws:runShellScript', 'name': 'run', 'inputs': {'timeoutSeconds': timeout, 'runCommand': lines}}]}
    if p:
        c['parameters'] = p
    return c


sub = lambda s: {'Fn::Sub': s}
acct = '${AWS::AccountId}'
tagged = {'StringEquals': {'aws:ResourceTag/ops-console': 'managed'}}
ssm_tagged = {'StringEquals': {'ssm:resourceTag/ops-console': 'managed'}}
statements = [
    {'Sid': 'RunOnlyOurDocuments', 'Effect': 'Allow', 'Action': 'ssm:SendCommand', 'Resource': sub(f'arn:${{AWS::Partition}}:ssm:${{AWS::Region}}:{acct}:document/OpsConsole-*')},
    {'Sid': 'OnlyOnTaggedInstances', 'Effect': 'Allow', 'Action': 'ssm:SendCommand', 'Resource': sub(f'arn:${{AWS::Partition}}:ec2:${{AWS::Region}}:{acct}:instance/*'), 'Condition': ssm_tagged},
    {'Sid': 'ReadStatus', 'Effect': 'Allow', 'Resource': '*', 'Action': [
        'ssm:GetCommandInvocation', 'ssm:DescribeInstanceInformation', 'ssm:DescribeDocument', 'ssm:DescribeParameters',
        'ec2:DescribeInstances', 'ec2:DescribeSecurityGroups', 'ce:GetCostAndUsage', 'ce:GetCostForecast',
        'scheduler:ListSchedules', 'scheduler:GetSchedule', 'route53:ListHostedZonesByName', 'route53:ListResourceRecordSets', 'route53:GetChange']},
    {'Sid': 'PowerTaggedInstances', 'Effect': 'Allow', 'Resource': sub(f'arn:${{AWS::Partition}}:ec2:${{AWS::Region}}:{acct}:instance/*'), 'Condition': tagged,
     'Action': ['ec2:StartInstances', 'ec2:StopInstances', 'ec2:RebootInstances', 'ec2:TerminateInstances', 'ec2:AssociateIamInstanceProfile']},
    {'Sid': 'TagServersYouAdd', 'Effect': 'Allow', 'Action': 'ec2:CreateTags',
     'Resource': [sub(f'arn:${{AWS::Partition}}:ec2:${{AWS::Region}}:{acct}:instance/*'), sub(f'arn:${{AWS::Partition}}:ec2:${{AWS::Region}}:{acct}:security-group/*')],
     'Condition': {'StringEquals': {'aws:RequestTag/ops-console': 'managed'}, 'ForAllValues:StringEquals': {'aws:TagKeys': ['ops-console']}}},
    {'Sid': 'GiveServersTheInstanceProfile', 'Effect': 'Allow', 'Action': 'iam:PassRole', 'Resource': {'Fn::GetAtt': ['InstanceRole', 'Arn']},
     'Condition': {'StringEquals': {'iam:PassedToService': 'ec2.amazonaws.com'}}},
    {'Sid': 'AppSettings', 'Effect': 'Allow', 'Action': ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath', 'ssm:PutParameter', 'ssm:DeleteParameter'],
     'Resource': [sub(f'arn:${{AWS::Partition}}:ssm:${{AWS::Region}}:{acct}:parameter/apps/*'), sub(f'arn:${{AWS::Partition}}:ssm:${{AWS::Region}}:{acct}:parameter/ops-console/git-tokens/*')]},
    {'Sid': 'EncryptSettingsViaSsm', 'Effect': 'Allow', 'Action': ['kms:Decrypt', 'kms:Encrypt'], 'Resource': '*',
     'Condition': {'StringEquals': {'kms:ViaService': sub('ssm.${AWS::Region}.amazonaws.com')}}},
    {'Sid': 'TerminalOnTaggedInstances', 'Effect': 'Allow', 'Action': 'ssm:StartSession',
     'Resource': sub(f'arn:${{AWS::Partition}}:ec2:${{AWS::Region}}:{acct}:instance/*'), 'Condition': {**ssm_tagged, 'BoolIfExists': {'ssm:SessionDocumentAccessCheck': 'true'}}},
    {'Sid': 'TerminalShellDocument', 'Effect': 'Allow', 'Action': 'ssm:StartSession', 'Resource': sub(f'arn:${{AWS::Partition}}:ssm:${{AWS::Region}}:{acct}:document/SSM-SessionManagerRunShell')},
    {'Sid': 'EndSessions', 'Effect': 'Allow', 'Action': ['ssm:TerminateSession', 'ssm:ResumeSession'], 'Resource': sub(f'arn:${{AWS::Partition}}:ssm:${{AWS::Region}}:{acct}:session/*')},
    {'Sid': 'SshRulesOnTaggedGroups', 'Effect': 'Allow', 'Action': ['ec2:AuthorizeSecurityGroupIngress', 'ec2:RevokeSecurityGroupIngress'],
     'Resource': sub(f'arn:${{AWS::Partition}}:ec2:${{AWS::Region}}:{acct}:security-group/*'), 'Condition': tagged},
    {'Sid': 'AppDnsRecords', 'Effect': 'Allow', 'Action': 'route53:ChangeResourceRecordSets', 'Resource': sub('arn:${AWS::Partition}:route53:::hostedzone/*')},
    {'Sid': 'KeepRunningTonight', 'Effect': 'Allow', 'Action': 'scheduler:UpdateSchedule', 'Resource': sub(f'arn:${{AWS::Partition}}:scheduler:${{AWS::Region}}:{acct}:schedule/*')},
    {'Sid': 'SchedulesKeepTheirRole', 'Effect': 'Allow', 'Action': 'iam:PassRole', 'Resource': sub(f'arn:${{AWS::Partition}}:iam::{acct}:role/*'),
     'Condition': {'StringEquals': {'iam:PassedToService': 'scheduler.amazonaws.com'}}},
]

resources = {
    'AccessRole': {'Type': 'AWS::IAM::Role', 'Properties': {
        'RoleName': sub('OpsConsoleAccess-${AWS::Region}'),
        'Description': 'Used by Ops Console for this account. Delete this stack to disconnect.',
        'MaxSessionDuration': 3600,
        'AssumeRolePolicyDocument': {'Version': '2012-10-17', 'Statement': [{
            'Effect': 'Allow', 'Principal': {'AWS': {'Ref': 'ConsolePrincipal'}}, 'Action': 'sts:AssumeRole',
            'Condition': {'StringEquals': {'sts:ExternalId': {'Ref': 'ExternalId'}}}}]},
        'Policies': [{'PolicyName': 'ops-console', 'PolicyDocument': {'Version': '2012-10-17', 'Statement': statements}}]}},
    'InstanceRole': {'Type': 'AWS::IAM::Role', 'Properties': {
        'RoleName': sub('OpsConsoleInstance-${AWS::Region}'),
        'Description': 'For servers managed by Ops Console: Session Manager and their own app settings.',
        'AssumeRolePolicyDocument': {'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow', 'Principal': {'Service': 'ec2.amazonaws.com'}, 'Action': 'sts:AssumeRole'}]},
        'ManagedPolicyArns': [sub('arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore')],
        'Policies': [{'PolicyName': 'app-settings', 'PolicyDocument': {'Version': '2012-10-17', 'Statement': [
            {'Effect': 'Allow', 'Action': ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
             'Resource': [sub(f'arn:${{AWS::Partition}}:ssm:${{AWS::Region}}:{acct}:parameter/apps/*'), sub(f'arn:${{AWS::Partition}}:ssm:${{AWS::Region}}:{acct}:parameter/ops-console/git-tokens/*')]},
            {'Effect': 'Allow', 'Action': 'kms:Decrypt', 'Resource': '*', 'Condition': {'StringEquals': {'kms:ViaService': sub('ssm.${AWS::Region}.amazonaws.com')}}}]}}]}},
    'InstanceProfile': {'Type': 'AWS::IAM::InstanceProfile', 'Properties': {
        'InstanceProfileName': sub('OpsConsoleInstance-${AWS::Region}'), 'Roles': [{'Ref': 'InstanceRole'}]}},
}
for name, script, desc, timeout, p in docs:
    resources[name.replace('-', '')] = {'Type': 'AWS::SSM::Document', 'Properties': {
        'Name': name, 'DocumentType': 'Command', 'DocumentFormat': 'JSON', 'UpdateMethod': 'NewVersion',
        'Content': doc_content(script, desc, timeout, p)}}

template = {
    'AWSTemplateFormatVersion': '2010-09-09',
    'Description': 'Ops Console access (one region). Creates a role only the console can use with your workspace\'s external ID, '
                   'an instance profile for your servers, and the console\'s fixed commands. Delete the stack to disconnect.',
    'Parameters': {
        'ExternalId': {'Type': 'String', 'AllowedPattern': '^[A-Za-z0-9-]{32,64}$', 'Description': "Your workspace's external ID (shown in the console)."},
        'ConsolePrincipal': {'Type': 'String', 'AllowedPattern': '^arn:aws:iam::\\d{12}:(role|user)/[A-Za-z0-9+=,.@_/-]+$',
                             'Description': 'The Ops Console identity allowed to use the role (shown in the console).'},
    },
    'Resources': resources,
    'Outputs': {
        'RoleArn': {'Description': 'Paste this into the console to finish connecting.', 'Value': {'Fn::GetAtt': ['AccessRole', 'Arn']}},
        'InstanceProfile': {'Description': 'Attached to servers you add in the console.', 'Value': {'Ref': 'InstanceProfile'}},
    },
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
body = json.dumps(template, indent=1)
open(OUT, 'w').write(body + '\n')
print(f'{OUT}: {len(docs)} documents, {len(body) // 1024} KB')
