"""Smoke test: full autonomous + immediate chain through the bridge commands."""
import json, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

def call(**req):
    p = subprocess.run([sys.executable, str(HERE / "bridge.py")], input=json.dumps(req), capture_output=True, text=True)
    r = json.loads(p.stdout)
    assert r["ok"], r
    return r

issuer, user, agent, merch = (call(cmd="keygen") for _ in range(4))
M = {"id": "m-1", "name": "Acme API", "website": "https://acme.example"}
ITEM = {"id": "api-credits", "title": "API credits"}
PI = {"type": "mastercard.srcDigitalCard", "id": "card-1", "description": "Mastercard **** 1234"}
l1 = call(cmd="issue_l1", issuer_private_jwk=issuer["private_jwk"], user_public_jwk=user["public_jwk"], subject="u1")["l1"]

l2 = call(cmd="autonomous_l2", l1=l1, user_private_jwk=user["private_jwk"], agent_public_jwk=agent["public_jwk"], agent_kid="a1",
          merchants=[M], acceptable_items=[ITEM], payment_instrument=PI, max_cents=5000)["l2"]
for amt, expect in ((2500, True), (9000, False)):
    l3 = call(cmd="autonomous_l3", l2=l2, agent_private_jwk=agent["private_jwk"], agent_kid="a1", merchant=M, item=ITEM, amount_cents=amt,
              merchant_private_jwk=merch["private_jwk"], payment_instrument=PI)
    v = call(cmd="validate", l1=l1, l2=l2, l3a=l3["l3a"], l2_payment=l3["l2_payment"], issuer_public_jwk=issuer["public_jwk"])
    print("autonomous", amt, v["valid"], v["errors"], v.get("amount_cents"))
    assert v["valid"] is expect

imm = call(cmd="immediate", l1=l1, user_private_jwk=user["private_jwk"], merchant=M, item=ITEM, amount_cents=1200,
           merchant_private_jwk=merch["private_jwk"], payment_instrument=PI)
v = call(cmd="validate", l1=l1, l2=imm["l2"], issuer_public_jwk=issuer["public_jwk"])
print("immediate", v)
assert v["valid"]
