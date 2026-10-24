"""JSON-over-stdin bridge to the Verifiable Intent reference implementation (v0.1, pinned in vendor/).

Usage: echo '{"cmd": "...", ...}' | python bridge.py   ->   one JSON object on stdout.

Commands:
  keygen            -> {private_jwk, public_jwk}
  issue_l1          issuer creates the L1 credential binding the user's key
  immediate         user signs final values (L1 + L2), no delegation
  autonomous_l2     user signs constraints delegating to the agent key (L2)
  autonomous_l3     agent builds L3a (network) + L3b (merchant) inside the L2 mandate
  validate          network-side verification: chain, constraints (STRICT), bindings
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
import uuid
from pathlib import Path

_SRC = Path(__file__).resolve().parent.parent / "vendor" / "verifiable-intent" / "src"
sys.path.insert(0, str(_SRC))

from verifiable_intent.crypto.disclosure import (  # noqa: E402
    _b64url_encode,
    build_selective_presentation,
    hash_bytes,
    hash_disclosure,
)
from verifiable_intent.crypto.sd_jwt import decode_sd_jwt, resolve_disclosures  # noqa: E402
from verifiable_intent.crypto.signing import (  # noqa: E402
    _jwt_encode,
    generate_es256_key,
    jwk_to_private_key,
    jwk_to_public_key,
    private_key_to_jwk,
    public_key_to_jwk,
)
from verifiable_intent.issuance.agent import create_layer3_checkout, create_layer3_payment  # noqa: E402
from verifiable_intent.issuance.issuer import create_layer1  # noqa: E402
from verifiable_intent.issuance.user import create_layer2_autonomous, create_layer2_immediate  # noqa: E402
from verifiable_intent.models.agent_mandate import (  # noqa: E402
    CheckoutL3Mandate,
    FinalCheckoutMandate,
    FinalPaymentMandate,
    PaymentL3Mandate,
)
from verifiable_intent.models.constraints import (  # noqa: E402
    AllowedMerchantConstraint,
    AllowedPayeeConstraint,
    CheckoutLineItemsConstraint,
    PaymentAmountConstraint,
)
from verifiable_intent.models.issuer_credential import IssuerCredential  # noqa: E402
from verifiable_intent.models.user_mandate import (  # noqa: E402
    CheckoutMandate,
    MandateMode,
    PaymentMandate,
    UserMandate,
)
from verifiable_intent.verification.chain import verify_chain  # noqa: E402
from verifiable_intent.verification.constraint_checker import StrictnessMode, check_constraints  # noqa: E402

AGENT_AUD = "https://agent.verifiable-intent.example"
NETWORK_AUD = "https://www.mastercard.com"
WALLET_ISS = "https://wallet.example.com"
AGENT_ISS = "https://agent.example.com"


def _find_disclosure(sd_jwt, predicate):
    for disc_str, disc_val in zip(sd_jwt.disclosures, sd_jwt.disclosure_values):
        value = disc_val[-1] if disc_val else None
        if predicate(value):
            return disc_str
    return None


def _checkout_jwt(merchant: dict, item: dict, amount_cents: int, merchant_key) -> str:
    now = int(time.time())
    payload = {
        "iss": merchant["website"],
        "sub": "cart_checkout",
        "iat": now,
        "exp": now + 3600,
        "cart": {
            "items": [
                {
                    "sku": item["id"],
                    "name": item["title"],
                    "quantity": 1,
                    "unitPrice": amount_cents / 100,
                }
            ],
            "subTotal": {"amount": amount_cents / 100, "currencyCode": "USD"},
        },
    }
    return _jwt_encode({"alg": "ES256", "typ": "JWT", "kid": merchant["id"]}, payload, merchant_key)


def _checkout_hash(checkout_jwt: str) -> str:
    return _b64url_encode(hashlib.sha256(checkout_jwt.encode("utf-8")).digest())


def cmd_keygen(_req: dict) -> dict:
    key = generate_es256_key()
    return {"private_jwk": private_key_to_jwk(key), "public_jwk": public_key_to_jwk(key)}


def cmd_issue_l1(req: dict) -> dict:
    now = int(time.time())
    cred = IssuerCredential(
        iss=req.get("issuer", "https://www.mastercard.com"),
        sub=req["subject"],
        iat=now,
        exp=now + int(req.get("ttl", 86400)),
        aud=WALLET_ISS,
        cnf_jwk=req["user_public_jwk"],
        email=req.get("email", "user@example.com"),
        pan_last_four=req.get("pan_last_four", "0000"),
        scheme="Mastercard",
    )
    l1 = create_layer1(cred, jwk_to_private_key(req["issuer_private_jwk"]))
    return {"l1": l1.serialize()}


def cmd_immediate(req: dict) -> dict:
    now = int(time.time())
    user_key = jwk_to_private_key(req["user_private_jwk"])
    merchant = req["merchant"]
    item = req["item"]
    amount = int(req["amount_cents"])
    checkout_jwt = _checkout_jwt(merchant, item, amount, jwk_to_private_key(req["merchant_private_jwk"]))
    c_hash = _checkout_hash(checkout_jwt)
    l1 = decode_sd_jwt(req["l1"])
    mandate = UserMandate(
        nonce=str(uuid.uuid4()),
        aud=AGENT_AUD,
        iat=now,
        iss=WALLET_ISS,
        exp=now + 900,
        mode=MandateMode.IMMEDIATE,
        sd_hash=hash_bytes(req["l1"].encode("ascii")),
        prompt_summary=req.get("summary", "User-approved purchase"),
        checkout_mandate=CheckoutMandate(vct="mandate.checkout.1", checkout_jwt=checkout_jwt, checkout_hash=c_hash),
        payment_mandate=PaymentMandate(
            vct="mandate.payment.1",
            payment_instrument=req["payment_instrument"],
            payee=merchant,
            currency="USD",
            amount=amount,
            transaction_id=c_hash,
        ),
    )
    _ = l1
    result = create_layer2_immediate(mandate, user_key)
    return {"l2": result.sd_jwt.serialize(), "checkout_hash": c_hash}


def cmd_autonomous_l2(req: dict) -> dict:
    now = int(time.time())
    user_key = jwk_to_private_key(req["user_private_jwk"])
    merchants = req["merchants"]
    items = req["acceptable_items"]
    mandate = UserMandate(
        nonce=str(uuid.uuid4()),
        aud=AGENT_AUD,
        iat=now,
        iss=WALLET_ISS,
        exp=now + int(req.get("ttl", 86400)),
        mode=MandateMode.AUTONOMOUS,
        sd_hash=hash_bytes(req["l1"].encode("ascii")),
        prompt_summary=req.get("summary", "Agent mandate"),
        checkout_mandate=CheckoutMandate(
            vct="mandate.checkout.open.1",
            cnf_jwk=req["agent_public_jwk"],
            cnf_kid=req["agent_kid"],
            constraints=[
                AllowedMerchantConstraint(allowed=merchants),
                CheckoutLineItemsConstraint(
                    items=[{"id": "line-item-1", "acceptable_items": items, "quantity": 1}],
                ),
            ],
        ),
        payment_mandate=PaymentMandate(
            vct="mandate.payment.open.1",
            cnf_jwk=req["agent_public_jwk"],
            cnf_kid=req["agent_kid"],
            payment_instrument=req["payment_instrument"],
            risk_data=req.get("risk_data", {}),
            constraints=[
                PaymentAmountConstraint(currency="USD", min=int(req.get("min_cents", 1)), max=int(req["max_cents"])),
                AllowedPayeeConstraint(allowed=merchants),
            ],
        ),
        merchants=merchants,
        acceptable_items=items,
    )
    l2 = create_layer2_autonomous(mandate, user_key)
    return {"l2": l2.serialize()}


def cmd_autonomous_l3(req: dict) -> dict:
    now = int(time.time())
    agent_key = jwk_to_private_key(req["agent_private_jwk"])
    merchant = req["merchant"]
    item = req["item"]
    amount = int(req["amount_cents"])
    l2 = decode_sd_jwt(req["l2"])
    l2_base_jwt = req["l2"].split("~")[0]

    checkout_jwt = _checkout_jwt(merchant, item, amount, jwk_to_private_key(req["merchant_private_jwk"]))
    c_hash = _checkout_hash(checkout_jwt)

    payment_disc = _find_disclosure(l2, lambda v: isinstance(v, dict) and v.get("vct") == "mandate.payment.open.1")
    checkout_disc = _find_disclosure(l2, lambda v: isinstance(v, dict) and v.get("vct") == "mandate.checkout.open.1")
    merchant_disc = _find_disclosure(l2, lambda v: isinstance(v, dict) and v.get("id") == merchant["id"] and "name" in v)
    item_disc = _find_disclosure(l2, lambda v: isinstance(v, dict) and v.get("id") == item["id"] and "title" in v)
    if not (payment_disc and checkout_disc and merchant_disc and item_disc):
        raise ValueError("merchant or item not present in the L2 mandate")

    nonce = str(uuid.uuid4())
    l3a = create_layer3_payment(
        PaymentL3Mandate(
            nonce=nonce,
            aud=NETWORK_AUD,
            iat=now,
            iss=AGENT_ISS,
            exp=now + 300,
            final_payment=FinalPaymentMandate(
                transaction_id=c_hash,
                payee=merchant,
                payment_amount={"currency": "USD", "amount": amount},
                payment_instrument=req["payment_instrument"],
            ),
            final_merchant=merchant,
        ),
        agent_key,
        l2_base_jwt,
        payment_disc,
        merchant_disc,
        kid=req["agent_kid"],
    )
    l3b = create_layer3_checkout(
        CheckoutL3Mandate(
            nonce=nonce,
            aud=merchant["website"],
            iat=now,
            iss=AGENT_ISS,
            exp=now + 300,
            final_checkout=FinalCheckoutMandate(checkout_jwt=checkout_jwt, checkout_hash=c_hash),
        ),
        agent_key,
        l2_base_jwt,
        checkout_disc,
        item_disc,
        kid=req["agent_kid"],
    )
    return {
        "l3a": l3a.serialize(),
        "l3b": l3b.serialize(),
        "l2_payment": build_selective_presentation(l2_base_jwt, [payment_disc, merchant_disc]),
        "l2_checkout": build_selective_presentation(l2_base_jwt, [checkout_disc, item_disc]),
        "checkout_hash": c_hash,
    }


def cmd_validate(req: dict) -> dict:
    """Network-side validation (mirrors examples/helpers.validate_intent) plus amount/payee extraction."""
    issuer_pub = jwk_to_public_key(req["issuer_public_jwk"])
    l1_ser, l2_ser = req["l1"], req["l2"]
    l3a_ser = req.get("l3a")
    l1, l2 = decode_sd_jwt(l1_ser), decode_sd_jwt(l2_ser)
    l3a = decode_sd_jwt(l3a_ser) if l3a_ser else None

    result = verify_chain(
        l1,
        l2,
        l3_payment=l3a,
        issuer_public_key=issuer_pub,
        l1_serialized=l1_ser,
        l2_serialized=l2_ser,
        l2_payment_serialized=req.get("l2_payment"),
    )
    out = {"valid": False, "errors": list(result.errors), "mode": None, "amount_cents": None, "payee": None}
    if not result.valid:
        return out

    l2_claims = result.l2_claims
    autonomous = any(isinstance(d, dict) and d.get("cnf") for d in l2_claims.get("delegate_payload", []))
    out["mode"] = "autonomous" if autonomous else "immediate"
    if autonomous and not l3a_ser:
        out["errors"].append("Autonomous intent requires Layer 3 fulfillment")
        return out

    if autonomous:
        l3_claims = result.l3_payment_claims
        constraints = []
        for d in l2_claims.get("delegate_payload", []):
            if isinstance(d, dict) and d.get("vct") == "mandate.payment.open.1":
                constraints = d.get("constraints", [])
                break
        fulfillment = {}
        for d in l3_claims.get("delegate_payload", []):
            if isinstance(d, dict) and d.get("vct") == "mandate.payment.1":
                fulfillment = d
                break
        if not constraints or not fulfillment:
            out["errors"].append("Missing disclosed L2 payment constraints or L3 payment mandate")
            return out
        disc_by_hash = {hash_disclosure(s): v for s, v in zip(l2.disclosures, l2.disclosure_values)}
        for c in constraints:
            if c.get("type") == "mandate.payment.allowed_payees":
                resolved = []
                for ref in c.get("allowed", []):
                    h = ref.get("...", "") if isinstance(ref, dict) else ""
                    if h and h in disc_by_hash:
                        resolved.append(disc_by_hash[h][-1])
                fulfillment["allowed_merchants"] = resolved
        cr = check_constraints(constraints, fulfillment, mode=StrictnessMode.STRICT)
        if not cr.satisfied:
            out["errors"].extend(cr.violations)
            return out
        pay = fulfillment.get("payment_amount", {})
        out["amount_cents"] = int(pay.get("amount", 0))
        out["payee"] = fulfillment.get("payee")
        out["max_cents"] = next((c.get("max") for c in constraints if c.get("type") == "mandate.payment.amount"), None)
    else:
        claims = resolve_disclosures(l2)
        for d in claims.get("delegate_payload", []):
            if isinstance(d, dict) and d.get("vct") == "mandate.payment.1":
                out["amount_cents"] = int(d.get("amount", 0)) if "amount" in d else int(d.get("payment_amount", {}).get("amount", 0))
                out["payee"] = d.get("payee")
    out["valid"] = True
    return out


COMMANDS = {
    "keygen": cmd_keygen,
    "issue_l1": cmd_issue_l1,
    "immediate": cmd_immediate,
    "autonomous_l2": cmd_autonomous_l2,
    "autonomous_l3": cmd_autonomous_l3,
    "validate": cmd_validate,
}


def main() -> None:
    req = json.loads(sys.stdin.read())
    try:
        res = COMMANDS[req["cmd"]](req)
        sys.stdout.write(json.dumps({"ok": True, **res}))
    except Exception as exc:  # noqa: BLE001 - surface any failure to the caller as data
        sys.stdout.write(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))


if __name__ == "__main__":
    main()
