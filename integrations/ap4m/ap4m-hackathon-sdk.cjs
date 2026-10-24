/**
 * AP4M Hackathon SDK — FOR HACKATHON USE ONLY
 * Split from Mastercard participant kit for BEC (agentic payments track).
 */

'use strict';

const PAYMENT_LEDGER_ABI = [
  'function redeemVoucher((bytes32 channelId, uint256 cumulativeAmount) voucher, bytes agentSignature) returns (bytes32 claimId, uint256 amount, bytes32 digest)',
];

const _CHANNELS_ABI = [
  'function channels(bytes32 channelId) view returns (bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,uint256,uint256,address,uint64,uint8,address,uint64,address,uint64,uint64,uint64)',
];

async function signIn(apiUrl, teamName, wallet) {
  const address = await wallet.getAddress();
  const challengeResp = await fetch(`${apiUrl}/public/participant/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamName, wallet: address }),
  });
  const challenge = await challengeResp.json();
  if (!challengeResp.ok) throw new Error(`sign-in challenge failed (${challengeResp.status}): ${challenge.error ?? JSON.stringify(challenge)}`);
  const signature = await wallet.signMessage(challenge.message);
  const sessionResp = await fetch(`${apiUrl}/public/participant/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId: challenge.challengeId, signature }),
  });
  const session = await sessionResp.json();
  if (!sessionResp.ok) throw new Error(`sign-in failed (${sessionResp.status}): ${session.error ?? JSON.stringify(session)}`);
  return session;
}

async function listMerchants(apiUrl) {
  const resp = await fetch(`${apiUrl}/public/merchants`);
  const data = await resp.json();
  if (!resp.ok) throw new Error(`listMerchants failed (${resp.status}): ${data.error ?? JSON.stringify(data)}`);
  return data.merchants;
}

async function requestChannel(apiUrl, teamToken, agentWallet, options) {
  const { ethers } = await _loadEthers();
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${teamToken}` };
  const prepareResp = await fetch(`${apiUrl}/public/participant/channel-requests/prepare`, {
    method: 'POST', headers, body: JSON.stringify({ cap_rlusd: String(options.capRlusd), merchant_id: options.merchantId }),
  });
  const prepared = await prepareResp.json();
  if (!prepareResp.ok) throw new Error(`channel request failed (${prepareResp.status}): ${prepared.error ?? JSON.stringify(prepared)}`);
  const signer = agentWallet.provider ? agentWallet : agentWallet.connect(new ethers.JsonRpcProvider(options.rpcUrl));
  const tx = await signer.sendTransaction({ to: prepared.to, data: prepared.data });
  await tx.wait();
  const recordResp = await fetch(`${apiUrl}/public/participant/channel-requests`, {
    method: 'POST', headers, body: JSON.stringify({ tx_hash: tx.hash }),
  });
  let channel = await recordResp.json();
  if (!recordResp.ok) throw new Error(`channel request was sent (${tx.hash}) but not recorded (${recordResp.status}): ${channel.error ?? JSON.stringify(channel)}`);
  const deadline = Date.now() + (options.timeoutMs ?? 180000);
  while (channel.channel_status !== 'open') {
    if (channel.channel_status === 'failed') throw new Error(`Channel ${channel.channel_id} failed: ${channel.failure}`);
    if (Date.now() > deadline) throw new Error(`Channel ${channel.channel_id} is still ${channel.channel_status}; check listChannels later.`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    channel = (await listChannels(apiUrl, teamToken)).find((entry) => entry.channel_id === channel.channel_id) ?? channel;
  }
  return channel;
}

async function listChannels(apiUrl, teamToken) {
  const resp = await fetch(`${apiUrl}/public/participant/channels`, { headers: { 'Authorization': `Bearer ${teamToken}` } });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`listChannels failed (${resp.status}): ${data.error ?? JSON.stringify(data)}`);
  return data.channels;
}

async function getChannelState(provider, ledgerAddress, channelId) {
  const { ethers } = await _loadEthers();
  const contract = new ethers.Contract(ledgerAddress, _CHANNELS_ABI, provider);
  const result = await contract.channels(channelId);
  return {
    cap: result[7],
    redeemed: result[8],
    validBefore: result[17],
    status: Number(result[11]),
  };
}

async function signVoucher(wallet, ledgerAddress, channelId, cumulativeAmount) {
  await _loadEthers();
  if (!wallet.provider) throw new Error('signVoucher: connect the wallet to the RPC from <service>/llms.txt first (wallet.connect(provider))');
  const chainId = (await wallet.provider.getNetwork()).chainId;
  const domain = {
    name: 'AP4M Payment Ledger',
    version: '1',
    chainId,
    verifyingContract: ledgerAddress,
  };
  const types = {
    Voucher: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'cumulativeAmount', type: 'uint256' },
    ],
  };
  return wallet.signTypedData(domain, types, { channelId, cumulativeAmount });
}

async function redeemVoucher(wallet, ledgerAddress, rpcUrl, channelId, cumulativeAmount) {
  const { ethers } = await _loadEthers();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = wallet.connect(provider);

  const signature = await signVoucher(signer, ledgerAddress, channelId, cumulativeAmount);

  const contract = new ethers.Contract(ledgerAddress, PAYMENT_LEDGER_ABI, signer);
  const tx = await contract.redeemVoucher({ channelId, cumulativeAmount }, signature);
  const receipt = await tx.wait();

  const eventTopic = ethers.id('VoucherRedeemed(bytes32,bytes32,bytes32,bytes32,address,bytes32,address,address,uint256,uint256,uint256)');
  const log = receipt.logs.find(
    (l) => l.address.toLowerCase() === ledgerAddress.toLowerCase() && l.topics[0] === eventTopic,
  );

  return {
    claimId: log ? log.topics[2] : null,
    txHash: receipt.hash,
  };
}

async function closeChannel(apiUrl, teamToken, agentWallet, channelId) {
  const { ethers } = await _loadEthers();

  const query = channelId ? `?channel_id=${encodeURIComponent(channelId)}` : '';
  const challengeResp = await fetch(`${apiUrl}/public/participant/close-channel-challenge${query}`, {
    headers: { 'Authorization': `Bearer ${teamToken}` },
  });
  const challengeData = await challengeResp.json();
  if (!challengeResp.ok) throw new Error(`close-channel-challenge failed (${challengeResp.status}): ${challengeData.error ?? JSON.stringify(challengeData)}`);

  const { domain, types, value } = challengeData.typedData;
  const typedValue = {
    ...value,
    finalCumulativeAmount: BigInt(value.finalCumulativeAmount),
    merchantPspSignerGeneration: BigInt(value.merchantPspSignerGeneration),
    signedAt: BigInt(value.signedAt),
  };
  const rawSig = await agentWallet.signTypedData(domain, types, typedValue);
  const sig = ethers.Signature.from(rawSig);

  const resp = await fetch(`${apiUrl}/public/participant/close-channel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${teamToken}`,
    },
    body: JSON.stringify({
      agent_signature_r: sig.r,
      agent_signature_vs: sig.yParityAndS,
      channel_id: challengeData.checkpoint.channelId,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`close-channel failed (${resp.status}): ${data.error ?? JSON.stringify(data)}`);
  return data;
}

async function settle(apiUrl, teamToken, channelId) {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(`${apiUrl}/public/participant/settle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${teamToken}`,
      },
      body: JSON.stringify(channelId ? { channel_id: channelId } : {}),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(`settle failed (${resp.status}): ${data.error ?? JSON.stringify(data)}`);
    if (resp.status !== 202) return data;
    if (attempt >= 40) throw new Error(`settle: payout ${data.payout_tx} is still waiting for confirmations`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

let _ethersCache = null;
async function _loadEthers() {
  if (_ethersCache) return _ethersCache;
  _ethersCache = { ethers: require('ethers') };
  return _ethersCache;
}

module.exports = {
  signIn,
  requestChannel,
  listChannels,
  listMerchants,
  signVoucher,
  redeemVoucher,
  closeChannel,
  settle,
  getChannelState,
};
