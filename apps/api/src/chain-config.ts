/**
 * The chain-binding configuration, from the environment — or a refusal naming every missing key.
 *
 * Nothing here has a default. `maxGasLimit`, `maxFeeCostWei` and the asset registry are each a claim
 * about what this deployment is willing to sign, and a default is this process writing a limit that
 * nobody set — the same shape as the "no transfer limit applies" mistake that `CONTRACT_VALUE_NOT_PERMITTED`
 * was written to close. A deployment that cannot start because it forgot a variable is the correct
 * failure; one that starts and mints tickets against an invented asset identity is not recoverable.
 *
 * The registry is a file rather than a table on purpose: `DELETE` is withheld from `ari_app` by `008`,
 * so a table would need a second write path and a role that can use it, and the operator's mental model
 * — "these are the tokens this deployment pays, and changing them is a deploy" — is a file's.
 */

import { readFileSync } from 'node:fs';
import type { ChainBindingConfig } from './chain-artifact.js';

const NETWORK_NAMES = ['mainnet', 'testnet', 'devnet', 'localnet'] as const;
type NetworkName = (typeof NETWORK_NAMES)[number];

const require = (env: NodeJS.ProcessEnv, name: string, missing: string[]): string => {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    missing.push(name);
    return '';
  }
  return value.trim();
};

export function chainBindingFromEnv(env: NodeJS.ProcessEnv): ChainBindingConfig {
  const missing: string[] = [];
  const chainIdsRaw = require(env, 'EVM_ALLOWED_CHAIN_IDS', missing);
  const gasRaw = require(env, 'EVM_MAX_GAS_LIMIT', missing);
  const feeRaw = require(env, 'EVM_MAX_FEE_COST_WEI', missing);
  const networkRaw = require(env, 'ARI_NETWORK_NAME', missing);
  const registryPath = require(env, 'EVM_ASSET_REGISTRY', missing);
  if (missing.length > 0) {
    throw new Error(
      `ari-api cannot start: the chain binding is unconfigured. Set ${missing.join(', ')} — `
      + 'a ticket must name the bytes it authorises, and those numbers are what makes that answer the deployment\'s rather than a default.',
    );
  }

  const chainIds = [...new Set(chainIdsRaw.split(',').map((value) => value.trim()).filter((value) => value !== ''))];
  if (chainIds.some((value) => !/^\d{1,39}$/.test(value))) {
    throw new Error(`ari-api cannot start: EVM_ALLOWED_CHAIN_IDS must be decimal chain ids, got "${chainIdsRaw}"`);
  }
  const gasLimit = BigInt(gasRaw);
  if (!/^\d+$/.test(gasRaw) || gasLimit <= 0n) {
    throw new Error(`ari-api cannot start: EVM_MAX_GAS_LIMIT must be a positive integer, got "${gasRaw}"`);
  }
  const feeCost = BigInt(feeRaw);
  if (!/^\d+$/.test(feeRaw) || feeCost <= 0n) {
    throw new Error(`ari-api cannot start: EVM_MAX_FEE_COST_WEI must be a positive integer, got "${feeRaw}"`);
  }
  if (!(NETWORK_NAMES as readonly string[]).includes(networkRaw)) {
    throw new Error(`ari-api cannot start: ARI_NETWORK_NAME is "${networkRaw}", expected one of ${NETWORK_NAMES.join('|')}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(registryPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`ari-api cannot start: EVM_ASSET_REGISTRY "${registryPath}" is unreadable: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`ari-api cannot start: EVM_ASSET_REGISTRY "${registryPath}" must be a JSON array`);

  const tokens: Record<string, { decimals: bigint; symbol: string }> = {};
  for (const entry of parsed as Array<{ contract?: unknown; decimals?: unknown; symbol?: unknown }>) {
    const contract = typeof entry.contract === 'string' ? entry.contract.toLowerCase() : '';
    const symbol = typeof entry.symbol === 'string' ? entry.symbol : '';
    const decimals = entry.decimals;
    if (!/^0x[0-9a-f]{40}$/.test(contract)) {
      throw new Error(`ari-api cannot start: registry entry ${JSON.stringify(entry)} names no lowercase 0x+40 contract`);
    }
    if (symbol === '' || (typeof decimals !== 'number' && typeof decimals !== 'string')) {
      throw new Error(`ari-api cannot start: registry entry for ${contract} needs a symbol and decimals`);
    }
    if (tokens[contract] !== undefined) {
      throw new Error(`ari-api cannot start: ${contract} is declared twice in the registry`);
    }
    tokens[contract] = { decimals: BigInt(String(decimals)), symbol };
  }
  if (Object.keys(tokens).length === 0) {
    throw new Error(`ari-api cannot start: ${registryPath} declares no tokens, so no ERC-20 payment can be given an asset identity`);
  }

  return {
    supported: ['evm'],
    networkName: networkRaw as NetworkName,
    allowedChainIds: chainIds,
    maxFeeCostWei: feeCost,
    maxGasLimit: gasLimit,
    tokens,
  };
}
