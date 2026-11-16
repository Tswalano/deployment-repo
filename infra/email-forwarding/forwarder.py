"""
glenify-mail-forwarder: forwards mail received by SES for *@glenify.studio to a private inbox.

Flow: SES receipt rule → (1) store raw message in S3 → (2) invoke this Lambda with the SES event.
The forward is sent *from the address it was originally sent to* (e.g. lendify@glenify.studio,
verified via the domain) with Reply-To set to the real sender, so replying from your inbox works
and SPF/DKIM/DMARC stay aligned with glenify.studio.

Config (environment):
  BUCKET            S3 bucket SES stores messages in
  PREFIX            key prefix used by the S3 action (e.g. "inbound/")
  FORWARD_TO_PARAM  SSM parameter holding the destination inbox (kept out of code/repo)
  SEND_REGION       SES region used to send (af-south-1)
"""
import email
import email.policy
import email.utils
import os

import boto3

BUCKET = os.environ["BUCKET"]
PREFIX = os.environ.get("PREFIX", "")
SEND_REGION = os.environ.get("SEND_REGION", "af-south-1")
DOMAIN = os.environ.get("DOMAIN", "glenify.studio")
MAX_BYTES = 9 * 1024 * 1024  # stay under SES's 10 MB raw message limit

s3 = boto3.client("s3")
ses = boto3.client("sesv2", region_name=SEND_REGION)
_forward_to = None


def forward_to() -> str:
    global _forward_to
    if _forward_to is None:
        ssm = boto3.client("ssm", region_name=SEND_REGION)
        _forward_to = ssm.get_parameter(Name=os.environ["FORWARD_TO_PARAM"], WithDecryption=True)["Parameter"]["Value"].strip()
    return _forward_to


def handler(event, _context):
    rec = event["Records"][0]["ses"]
    mail, receipt = rec["mail"], rec["receipt"]

    # Drop spam/virus before forwarding anything.
    for verdict in ("spamVerdict", "virusVerdict", "spfVerdict", "dkimVerdict"):
        status = receipt.get(verdict, {}).get("status")
        if verdict in ("spamVerdict", "virusVerdict") and status == "FAIL":
            print(f"dropped {mail['messageId']}: {verdict}=FAIL")
            return {"disposition": "STOP_RULE"}

    raw = s3.get_object(Bucket=BUCKET, Key=f"{PREFIX}{mail['messageId']}")["Body"].read()
    if len(raw) > MAX_BYTES:
        print(f"dropped {mail['messageId']}: {len(raw)} bytes exceeds forward limit")
        return {"disposition": "STOP_RULE"}

    msg = email.message_from_bytes(raw, policy=email.policy.SMTP)

    # Which of our addresses was it sent to? Use it as the forwarding sender.
    ours = [r for r in receipt.get("recipients", []) if r.lower().endswith("@" + DOMAIN)]
    via = ours[0] if ours else f"mail@{DOMAIN}"
    original_from = msg.get("From", mail.get("source", "unknown"))
    name, addr = email.utils.parseaddr(str(original_from))

    # Rewrite headers that would break delivery (sender not ours / old signatures).
    for h in ("From", "Sender", "Return-Path", "Reply-To", "DKIM-Signature", "Message-ID", "To", "Cc"):
        del msg[h]
    msg["From"] = email.utils.formataddr((f"{name or addr} via {DOMAIN}", via))
    msg["Reply-To"] = str(original_from)
    msg["To"] = forward_to()
    msg["X-Original-To"] = ", ".join(receipt.get("recipients", []))

    ses.send_email(
        FromEmailAddress=via,
        Destination={"ToAddresses": [forward_to()]},
        Content={"Raw": {"Data": msg.as_bytes()}},
    )
    print(f"forwarded {mail['messageId']} for {via}")
    return {"disposition": "CONTINUE"}
