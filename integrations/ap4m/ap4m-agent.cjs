/**
 * AP4M Hackathon — example agent flow (sign-in → channel → pay → settle → close).
 * FOR HACKATHON USE ONLY. Node.js 22.13+ recommended.
 *
 * Env (set in .env.local; loaded below):
 *   AGENT_PRIVATE_KEY  — agent wallet (needs gas on hackathon chain)
 *   TEAM_NAME          — registered team name on participant portal
 *   AP4M_API_URL       — default https://hackathon.ap4m.build
 *   CHANNEL_ID         — optional existing channel; omit to open new
 *   CHANNEL_CAP        — RLUSD cap when opening (default 5)
 *   PAYMENT_LEDGER     — optional override; else from GET /public/config
 *   AP4M_RPC_URL       — optional override; else from /public/config
 */

'use strict';

const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { ethers } = require('ethers');

const {
  signIn,
  requestChannel,
  getChannelState,
  redeemVoucher,
  settle,
  closeChannel,
} = require('./ap4m-hackathon-sdk.cjs');

loadEnvLocal();

const AGENT_PRIVATE_KEY = normalizePrivateKey(process.env.AGENT_PRIVATE_KEY || '');
const TEAM_NAME = process.env.TEAM_NAME || '';
const AP4M_API_URL = process.env.AP4M_API_URL || 'https://hackathon.ap4m.build';
const CHANNEL_ID = process.env.CHANNEL_ID || '';
const CHANNEL_CAP = process.env.CHANNEL_CAP || '5';
const PAYMENT_LEDGER = process.env.PAYMENT_LEDGER || '';

function normalizePrivateKey(key) {
  const trimmed = key.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

function loadEnvLocal() {
  const path = resolve(__dirname, '../../.env.local');
  try {
    const content = readFileSync(path, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // optional
  }
}

async function main() {
  if (!AGENT_PRIVATE_KEY) {
    console.error('Set AGENT_PRIVATE_KEY in .env.local (agent wallet private key).');
    process.exit(1);
  }
  if (!TEAM_NAME) {
    console.error('Set TEAM_NAME in .env.local (participant portal team name).');
    process.exit(1);
  }

  const agentWallet = new ethers.Wallet(AGENT_PRIVATE_KEY);
  console.log('Agent wallet:', agentWallet.address);

  const configResp = await fetch(`${AP4M_API_URL}/public/config`);
  const config = await configResp.json();
  if (!configResp.ok) {
    console.error('Could not read the service configuration:', config.error);
    process.exit(1);
  }
  const RPC_URL = process.env.AP4M_RPC_URL || config.network.rpcUrl;
  const ledgerAddress = PAYMENT_LEDGER || config.contracts.paymentLedger;

  console.log('\n[1] Signing in...');
  const sessionData = await signIn(AP4M_API_URL, TEAM_NAME, agentWallet);
  const token = sessionData.token;
  console.log('Logged in. Channel status:', sessionData.paymentState?.channel_status);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const network = await provider.getNetwork();
  const balance = await provider.getBalance(agentWallet.address);
  console.log(`Chain ID ${network.chainId} | native balance: ${ethers.formatEther(balance)} (need gas for channel tx)`);
  if (balance === 0n && !CHANNEL_ID) {
    console.error(
      'Agent wallet has no native gas. Fund this address on the hackathon chain (portal faucet / staff), then retry.',
    );
    process.exit(1);
  }

  let channelId = CHANNEL_ID;
  if (!channelId) {
    console.log(`\n[2] Requesting a Channel with a ${CHANNEL_CAP} RLUSD limit...`);
    const channel = await requestChannel(AP4M_API_URL, token, agentWallet.connect(provider), {
      capRlusd: CHANNEL_CAP,
      rpcUrl: RPC_URL,
    });
    channelId = channel.channel_id;
    console.log('Channel open:', channelId);
  }

  console.log('\n[3] Reading channel state and submitting payment...');
  const state = await getChannelState(provider, ledgerAddress, channelId);
  console.log('Cap:     ', ethers.formatUnits(state.cap, 18), 'RLUSD');
  console.log('Redeemed:', ethers.formatUnits(state.redeemed, 18), 'RLUSD');

  const thisPayment = ethers.parseUnits('1', 18);
  const cumulativeAmount = state.redeemed + thisPayment;

  const { claimId, txHash } = await redeemVoucher(
    agentWallet,
    ledgerAddress,
    RPC_URL,
    channelId,
    cumulativeAmount,
  );
  console.log('Payment submitted. TX:', txHash);
  console.log('Claim ID:', claimId);

  console.log('\n[4] Reporting payment to service...');
  const recordResp = await fetch(`${AP4M_API_URL}/public/participant/record-redemption`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tx_hash: txHash }),
  });
  const recordData = await recordResp.json();
  if (!recordResp.ok) {
    console.error('record-redemption failed:', recordData.error);
    process.exit(1);
  }
  console.log('Payment reported. Claim ID:', recordData.claim_id);

  console.log('\n[5] Settling...');
  const settled = await settle(AP4M_API_URL, token, channelId);
  console.log('Settlement recorded. TX:', settled.settlement_tx);
  console.log('RLUSD sent to merchant.  TX:', settled.payout_tx);
  if (settled.receipt_url) console.log('Verifiable receipt:', AP4M_API_URL + settled.receipt_url);

  console.log('\n[6] Closing channel...');
  const closed = await closeChannel(AP4M_API_URL, token, agentWallet, channelId);
  console.log('Channel closed. TX:', closed.tx_hash);

  console.log('\nDone. RLUSD has been sent to your registered payout wallet.');
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
