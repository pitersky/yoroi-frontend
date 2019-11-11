// @flow

import type {
  lf$Database, lf$Transaction,
} from 'lovefield';

import {
  groupBy,
  mapValues,
} from 'lodash';

import {
  BigNumber
} from 'bignumber.js';

import type {
  IPublicDeriver,
  UtxoAddressPath,
  IGetAllUtxos,
  IGetUtxoBalanceResponse,
  IHasChainsRequest,
  IGetNextUnusedForChainResponse,
  IHasChains,
  IDisplayCutoff,
  BaseAddressPath,
} from './PublicDeriver/interfaces';
import {
  PublicDeriver,
} from './PublicDeriver/index';
import {
  asDisplayCutoff,
  asGetAllUtxos,
} from './Bip44Wallet/traits';
import {
  asGetAllAccounting,
} from './Cip1852Wallet/traits';
import { Bip44Wallet, } from './Bip44Wallet/wrapper';

import type {
  IChangePasswordRequest, IChangePasswordResponse,
  Address, Value, Addressing, UsedStatus,
} from './common/interfaces';

import type {
  AddressRow,
  KeyInsert, KeyRow,
  CanonicalAddressRow,
} from '../database/primitives/tables';
import type {
  CoreAddressT
} from '../database/primitives/enums';
import {
  UpdateGet, AddAddress,
} from '../database/primitives/api/write';
import {
  ModifyDisplayCutoff,
} from '../database/walletTypes/bip44/api/write';
import type {
  TreeInsert
} from '../database/walletTypes/common/utils';
import {
  GetAddress,
  GetPathWithSpecific,
  GetDerivationsByPath,
} from '../database/primitives/api/read';
import {
  getAllSchemaTables,
  raii,
  mapToTables,
} from '../database/utils';
import {
  GetAllBip44Wallets,
} from '../database/walletTypes/bip44/api/read';
import {
  GetDerivationSpecific,
} from '../database/walletTypes/common/api/read';
import type { UtxoTxOutput } from '../database/transactionModels/utxo/api/read';
import type { UtxoTransactionOutputRow } from '../database/transactionModels/utxo/tables';
import { Bip44DerivationLevels } from '../database/walletTypes/bip44/api/utils';
import type { GetPathWithSpecificByTreeRequest } from '../database/primitives/api/read';
import {
  addressToKind,
} from '../bridge/utils';
import {
  GetUtxoTxOutputsWithTx,
} from '../database/transactionModels/utxo/api/read';
import { TxStatusCodes, CoreAddressTypes, } from '../database/primitives/enums';

import { WrongPassphraseError } from '../../cardanoCrypto/cryptoErrors';

import { RustModule } from '../../cardanoCrypto/rustLoader';

import { EXTERNAL, INTERNAL, BIP44_SCAN_SIZE, } from  '../../../../../config/numbersConfig';
import {
  encryptWithPassword,
  decryptWithPassword,
} from '../../../../../utils/passwordCipher';
import type { ConfigType } from '../../../../../../config/config-types';

declare var CONFIG: ConfigType;
const protocolMagic = CONFIG.network.protocolMagic;

export type ToAbsoluteSlotNumberRequest = {
  epoch: number,
  slot: number,
};
export type ToAbsoluteSlotNumberResponse = number;
export type ToAbsoluteSlotNumberFunc = (
  request: ToAbsoluteSlotNumberRequest
) => ToAbsoluteSlotNumberResponse;

export async function genToAbsoluteSlotNumber(): Promise<ToAbsoluteSlotNumberFunc> {
  // TODO: Cardano in the future will have a variable epoch size
  // and sidechains/networks can have different epoch sizes
  // so this needs to come from a DB
  return (request: ToAbsoluteSlotNumberRequest) => {
    return (21600 * request.epoch) + request.slot;
  };
}

export type TimeSinceGenesisRequest = {
  absoluteSlot: number,
};
export type TimeSinceGenesisResponse = number;
export type TimeSinceGenesisRequestFunc = (
  request: TimeSinceGenesisRequest
) => TimeSinceGenesisResponse;
export async function genTimeSinceGenesis(): Promise<TimeSinceGenesisRequestFunc> {
  // TODO: Cardano in the future will have a variable slot length
  // and sidechains/networks can have different epoch sizes
  // so this needs to come from a DB
  return (request: TimeSinceGenesisRequest) => {
    return (20 * request.absoluteSlot);
  };
}

export function normalizeBip32Ed25519ToPubDeriverLevel(request: {
  privateKeyRow: $ReadOnly<KeyRow>,
  password: null | string,
  path: Array<number>,
}): {
  prvKeyHex: string,
  pubKeyHex: string,
} {
  const prvKey = decryptKey(
    request.privateKeyRow,
    request.password,
  );
  const wasmKey = RustModule.WalletV2.PrivateKey.from_hex(prvKey);
  const newKey = deriveKeyV2(
    wasmKey,
    request.path,
  );
  return {
    prvKeyHex: newKey.to_hex(),
    pubKeyHex: newKey.public().to_hex()
  };
}

export function decryptKey(
  keyRow: $ReadOnly<KeyRow>,
  password: null | string,
): string {
  let rawKey;
  if (keyRow.IsEncrypted) {
    if (password === null) {
      throw new WrongPassphraseError();
    }
    const keyBytes = decryptWithPassword(password, keyRow.Hash);
    rawKey = Buffer.from(keyBytes).toString('hex');

  } else {
    rawKey = keyRow.Hash;
  }
  return rawKey;
}


export function deriveKeyV2(
  startingKey: RustModule.WalletV2.PrivateKey,
  pathToPublic: Array<number>,
): RustModule.WalletV2.PrivateKey {
  let currKey = startingKey;
  for (let i = 0; i < pathToPublic.length; i++) {
    currKey = currKey.derive(
      RustModule.WalletV2.DerivationScheme.v2(),
      pathToPublic[i],
    );
  }

  return currKey;
}

export async function rawGetDerivationsByPath<
  Row: { +KeyDerivationId: number }
>(
  db: lf$Database,
  tx: lf$Transaction,
  deps: {|
    GetDerivationSpecific: Class<GetDerivationSpecific>,
    GetPathWithSpecific: Class<GetPathWithSpecific>,
  |},
  request: GetPathWithSpecificByTreeRequest,
  level: number,
  derivationTables: Map<number, string>,
): Promise<Array<{|
  row: $ReadOnly<Row>,
  ...Addressing,
|}>> {
  const pathWithSpecific = await deps.GetPathWithSpecific.getTree<Row>(
    db, tx,
    request,
    async (derivationIds) => {
      const result = await deps.GetDerivationSpecific.get<Row>(
        db, tx,
        derivationIds,
        level,
        derivationTables,
      );
      return result;
    }
  );
  const result = pathWithSpecific.rows.map(row => {
    const path = pathWithSpecific.pathMap.get(row.KeyDerivationId);
    if (path == null) {
      throw new Error('getDerivationsByPath should never happen');
    }
    return {
      row,
      addressing: {
        path,
        startLevel: request.derivationLevel - request.commonPrefix.length + 1,
      },
    };
  });
  return result;
}

export async function rawGetBip44AddressesByPath(
  db: lf$Database,
  tx: lf$Transaction,
  deps: {
    GetPathWithSpecific: Class<GetPathWithSpecific>,
    GetAddress: Class<GetAddress>,
    GetDerivationSpecific: Class<GetDerivationSpecific>,
  },
  request: GetPathWithSpecificByTreeRequest,
  derivationTables: Map<number, string>,
): Promise<Array<BaseAddressPath>> {
  const canonicalAddresses = await rawGetDerivationsByPath<CanonicalAddressRow>(
    db, tx,
    {
      GetPathWithSpecific: deps.GetPathWithSpecific,
      GetDerivationSpecific: deps.GetDerivationSpecific,
    },
    request,
    Bip44DerivationLevels.ADDRESS.level,
    derivationTables,
  );
  const family = await deps.GetAddress.fromCanonical(
    db, tx,
    canonicalAddresses.map(addr => addr.row.KeyDerivationId),
    undefined,
  );
  return canonicalAddresses.map(canonical => {
    const addrs = family.get(canonical.row.KeyDerivationId);
    if (addrs == null) {
      throw new Error('getBip44AddressesByPath should never happen');
    }
    return {
      ...canonical,
      addrs,
    };
  });
}

export function getLastUsedIndex(request: {
  singleChainAddresses: Array<UtxoAddressPath>,
  usedStatus: Set<number>,
}): number {
  request.singleChainAddresses.sort((a1, a2) => {
    const index1 = a1.addressing.path[a1.addressing.path.length - 1];
    const index2 = a2.addressing.path[a2.addressing.path.length - 1];
    return index1 - index2;
  });

  let lastUsedIndex = -1;
  for (let i = 0; i < request.singleChainAddresses.length; i++) {
    for (const addr of request.singleChainAddresses[i].addrs) {
      if (request.usedStatus.has(addr.AddressId)) {
        lastUsedIndex = i;
      }
    }
  }
  return lastUsedIndex;
}

export async function rawGetUtxoUsedStatus(
  db: lf$Database,
  tx: lf$Transaction,
  deps: {| GetUtxoTxOutputsWithTx: Class<GetUtxoTxOutputsWithTx>, |},
  request: {
    addressIds: Array<number>,
  },
): Promise<Set<number>> {
  const outputs = await deps.GetUtxoTxOutputsWithTx.getOutputsForAddresses(
    db, tx,
    request.addressIds,
    [TxStatusCodes.IN_BLOCK]
  );
  return new Set(outputs.map(output => output.UtxoTransactionOutput.AddressId));
}

export async function rawGetAddressesForDisplay(
  db: lf$Database,
  tx: lf$Transaction,
  deps: {|
    GetUtxoTxOutputsWithTx: Class<GetUtxoTxOutputsWithTx>,
  |},
  request: {
    addresses: Array<UtxoAddressPath>,
    type: CoreAddressT,
  },
): Promise<Array<{| ...Address, ...Value, ...Addressing, ...UsedStatus |}>> {
  const addressIds = request.addresses
    .flatMap(family => family.addrs)
    .filter(addr => addr.Type === request.type)
    .map(addr => addr.AddressId);
  const utxosForAddresses = await rawGetUtxoUsedStatus(
    db, tx,
    { GetUtxoTxOutputsWithTx: deps.GetUtxoTxOutputsWithTx },
    { addressIds },
  );
  const utxoForAddresses = await deps.GetUtxoTxOutputsWithTx.getUtxo(
    db, tx,
    addressIds,
  );
  const balanceForAddresses = getUtxoBalanceForAddresses(utxoForAddresses);

  return request.addresses.flatMap(family => family.addrs.map(addr => ({
    address: addr.Hash,
    value: balanceForAddresses[addr.AddressId],
    addressing: family.addressing,
    isUsed: utxosForAddresses.has(addr.AddressId),
  })));
}

export async function rawGetChainAddressesForDisplay(
  tx: lf$Transaction,
  deps: {|
    GetUtxoTxOutputsWithTx: Class<GetUtxoTxOutputsWithTx>,
    GetAddress: Class<GetAddress>,
    GetPathWithSpecific: Class<GetPathWithSpecific>,
    GetDerivationSpecific: Class<GetDerivationSpecific>,
  |},
  request: {
    publicDeriver: IPublicDeriver & IHasChains & IDisplayCutoff,
    chainsRequest: IHasChainsRequest,
    type: CoreAddressT,
  },
  derivationTables: Map<number, string>,
): Promise<Array<{| ...Address, ...Value, ...Addressing, ...UsedStatus |}>> {
  const addresses = await request.publicDeriver.rawGetAddressesForChain(
    tx,
    {
      GetAddress: deps.GetAddress,
      GetPathWithSpecific: deps.GetPathWithSpecific,
      GetDerivationSpecific: deps.GetDerivationSpecific,
    },
    request.chainsRequest,
    derivationTables,
  );
  let belowCutoff = addresses;
  if (request.chainsRequest.chainId === EXTERNAL) {
    const cutoff = await request.publicDeriver.rawGetCutoff(
      tx,
      {
        GetPathWithSpecific: deps.GetPathWithSpecific,
        GetDerivationSpecific: deps.GetDerivationSpecific,
      },
      undefined,
      derivationTables,
    );
    belowCutoff = addresses.filter(address => (
      address.addressing.path[address.addressing.path.length - 1] <= cutoff
    ));
  }
  let addressResponse = await rawGetAddressesForDisplay(
    request.publicDeriver.getDb(), tx,
    { GetUtxoTxOutputsWithTx: deps.GetUtxoTxOutputsWithTx },
    {
      addresses: belowCutoff,
      type: request.type
    },
  );
  if (request.chainsRequest.chainId === INTERNAL) {
    let bestUsed = -1;
    for (const address of addressResponse) {
      if (address.isUsed) {
        const index = address.addressing.path[address.addressing.path.length - 1];
        if (index > bestUsed) {
          bestUsed = index;
        }
      }
    }
    addressResponse = addressResponse.filter(address => (
      address.addressing.path[address.addressing.path.length - 1] <= bestUsed + 1
    ));
  }
  return addressResponse;
}
export async function getChainAddressesForDisplay(
  request: {
    publicDeriver: IPublicDeriver & IHasChains & IDisplayCutoff,
    chainsRequest: IHasChainsRequest,
    type: CoreAddressT,
  },
): Promise<Array<{| ...Address, ...Value, ...Addressing, ...UsedStatus |}>> {
  const derivationTables = request.publicDeriver.getConceptualWallet().getDerivationTables();
  const deps = Object.freeze({
    GetUtxoTxOutputsWithTx,
    GetAddress,
    GetPathWithSpecific,
    GetDerivationSpecific,
  });
  const depTables = Object
    .keys(deps)
    .map(key => deps[key])
    .flatMap(table => getAllSchemaTables(request.publicDeriver.getDb(), table));
  return await raii(
    request.publicDeriver.getDb(),
    [
      ...depTables,
      ...mapToTables(request.publicDeriver.getDb(), derivationTables),
    ],
    async tx => await rawGetChainAddressesForDisplay(tx, deps, request, derivationTables)
  );
}
export async function rawGetAllAddressesForDisplay(
  tx: lf$Transaction,
  deps: {|
    GetUtxoTxOutputsWithTx: Class<GetUtxoTxOutputsWithTx>,
    GetAddress: Class<GetAddress>,
    GetPathWithSpecific: Class<GetPathWithSpecific>,
    GetDerivationSpecific: Class<GetDerivationSpecific>,
  |},
  request: {
    publicDeriver: IPublicDeriver & IGetAllUtxos,
    type: CoreAddressT,
  },
  derivationTables: Map<number, string>,
): Promise<Array<{| ...Address, ...Value, ...Addressing, ...UsedStatus |}>> {
  let addresses = await request.publicDeriver.rawGetAllUtxoAddresses(
    tx,
    {
      GetAddress: deps.GetAddress,
      GetPathWithSpecific: deps.GetPathWithSpecific,
      GetDerivationSpecific: deps.GetDerivationSpecific,
    },
    undefined,
    derivationTables,
  );
  // when public deriver level = chain we still have a display cutoff
  const hasCutoff = asDisplayCutoff(request.publicDeriver);
  if (hasCutoff != null) {
    const cutoff = await hasCutoff.rawGetCutoff(
      tx,
      {
        GetPathWithSpecific: deps.GetPathWithSpecific,
        GetDerivationSpecific: deps.GetDerivationSpecific,
      },
      undefined,
      derivationTables,
    );
    addresses = addresses.filter(address => (
      address.addressing.path[address.addressing.path.length - 1] <= cutoff
    ));
  }
  return await rawGetAddressesForDisplay(
    request.publicDeriver.getDb(), tx,
    { GetUtxoTxOutputsWithTx: deps.GetUtxoTxOutputsWithTx },
    {
      addresses,
      type: request.type
    },
  );
}
export async function getAllAddressesForDisplay(
  request: {
    publicDeriver: IPublicDeriver & IGetAllUtxos,
    type: CoreAddressT,
  },
): Promise<Array<{| ...Address, ...Value, ...Addressing, ...UsedStatus |}>> {
  const derivationTables = request.publicDeriver.getConceptualWallet().getDerivationTables();
  const deps = Object.freeze({
    GetUtxoTxOutputsWithTx,
    GetAddress,
    GetPathWithSpecific,
    GetDerivationSpecific,
  });
  const depTables = Object
    .keys(deps)
    .map(key => deps[key])
    .flatMap(table => getAllSchemaTables(request.publicDeriver.getDb(), table));
  return await raii(
    request.publicDeriver.getDb(),
    [
      ...depTables,
      ...mapToTables(request.publicDeriver.getDb(), derivationTables),
    ],
    async tx => await rawGetAllAddressesForDisplay(
      tx,
      deps,
      request,
      derivationTables,
    )
  );
}

export async function rawGetNextUnusedIndex(
  db: lf$Database,
  tx: lf$Transaction,
  deps: {|
    GetUtxoTxOutputsWithTx: Class<GetUtxoTxOutputsWithTx>,
  |},
  request:  {|
    addressesForChain: Array<UtxoAddressPath>,
  |}
): Promise<{|
  addressInfo: void | UtxoAddressPath,
  index: number,
|}> {
  const usedStatus = await rawGetUtxoUsedStatus(
    db, tx,
    { GetUtxoTxOutputsWithTx: deps.GetUtxoTxOutputsWithTx },
    { addressIds: request.addressesForChain
      .flatMap(address => address.addrs.map(addr => addr.AddressId))
    }
  );
  const lastUsedIndex = getLastUsedIndex({
    singleChainAddresses: request.addressesForChain,
    usedStatus,
  });

  const nextInternalAddress = request.addressesForChain[lastUsedIndex + 1];
  if (nextInternalAddress === undefined) {
    return {
      addressInfo: undefined,
      index: lastUsedIndex + 1,
    };
  }
  return {
    addressInfo: {
      ...nextInternalAddress
    },
    index: lastUsedIndex + 1,
  };
}

export function getUtxoBalanceForAddresses(
  utxos: $ReadOnlyArray<$ReadOnly<UtxoTxOutput>>,
): { [key: number]: IGetUtxoBalanceResponse } {
  const groupByAddress = groupBy(
    utxos,
    utxo => utxo.UtxoTransactionOutput.AddressId
  );
  const mapping = mapValues(
    groupByAddress,
    (utxoList: Array<$ReadOnly<UtxoTxOutput>>) => getBalanceForUtxos(
      utxoList.map(utxo => utxo.UtxoTransactionOutput)
    )
  );
  return mapping;
}

export function getBalanceForUtxos(
  utxos: $ReadOnlyArray<$ReadOnly<UtxoTransactionOutputRow>>,
): IGetUtxoBalanceResponse {
  const amounts = utxos.map(utxo => new BigNumber(utxo.Amount));
  const total = amounts.reduce(
    (acc, amount) => acc.plus(amount),
    new BigNumber(0)
  );
  return total;
}

export async function rawChangePassword(
  db: lf$Database,
  tx: lf$Transaction,
  deps: { UpdateGet: Class<UpdateGet> },
  request: IChangePasswordRequest & {
    oldKeyRow: $ReadOnly<KeyRow>,
  },
): Promise<IChangePasswordResponse> {
  const decryptedKey = decryptKey(
    request.oldKeyRow,
    request.oldPassword,
  );

  let newKey = decryptedKey;
  if (request.newPassword !== null) {
    newKey = encryptWithPassword(
      request.newPassword,
      Buffer.from(decryptedKey, 'hex'),
    );
  }

  const newRow: KeyRow = {
    KeyId: request.oldKeyRow.KeyId,
    Hash: newKey,
    IsEncrypted: request.newPassword !== null,
    PasswordLastUpdate: request.currentTime,
  };

  return await deps.UpdateGet.update(
    db, tx,
    newRow,
  );
}

export async function loadWalletsFromStorage(
  db: lf$Database,
): Promise<Array<PublicDeriver>> {
  const deps = Object.freeze({
    GetAllBip44Wallets,
  });
  const depTables = Object
    .keys(deps)
    .map(key => deps[key])
    .flatMap(table => getAllSchemaTables(db, table));
  const bip44Wallets = await raii(
    db,
    depTables,
    async tx => deps.GetAllBip44Wallets.get(db, tx)
  );
  const bip44Map = new Map<number, Bip44Wallet>();
  const result = [];
  for (const entry of bip44Wallets) {
    let bip44Wallet = bip44Map.get(entry.Bip44Wrapper.Bip44WrapperId);
    if (bip44Wallet == null) {
      bip44Wallet = await Bip44Wallet.createBip44Wallet(
        db,
        entry.Bip44Wrapper,
        protocolMagic,
      );
      bip44Map.set(entry.Bip44Wrapper.Bip44WrapperId, bip44Wallet);
    }
    const publicDeriver = await PublicDeriver.createPublicDeriver(
      entry.PublicDeriver,
      bip44Wallet,
    );
    result.push(publicDeriver);
  }
  return result;
}

export async function rawGetAddressRowsForWallet(
  tx: lf$Transaction,
  deps: {|
    GetPathWithSpecific: Class<GetPathWithSpecific>,
    GetAddress: Class<GetAddress>,
    GetDerivationSpecific: Class<GetDerivationSpecific>,
  |},
  request: {
    publicDeriver: IPublicDeriver,
  },
  derivationTables: Map<number, string>,
): Promise<{|
  utxoAddresses: Array<$ReadOnly<AddressRow>>,
  accountingAddresses: Array<$ReadOnly<AddressRow>>,
|}> {
  const utxoAddresses = [];
  const accountingAddresses = [];
  const withUtxos = asGetAllUtxos(request.publicDeriver);
  if (withUtxos != null) {
    const addrResponse = await withUtxos.rawGetAllUtxoAddresses(
      tx,
      {
        GetPathWithSpecific: deps.GetPathWithSpecific,
        GetAddress: deps.GetAddress,
        GetDerivationSpecific: deps.GetDerivationSpecific,
      },
      undefined,
      derivationTables,
    );
    for (const family of addrResponse) {
      for (const addr of family.addrs) {
        utxoAddresses.push(addr);
      }
    }
  }
  // TODO: behavior different for CIP1852 vs Bip44
  // const withAccounting = asGetAllAccounting(request.publicDeriver);
  // if (withAccounting != null) {
  //   const addrResponse = await withAccounting.rawGetAllAccountingAddresses(
  //     tx,
  //     {
  //       GetPathWithSpecific: deps.GetPathWithSpecific,
  //       GetAddress: deps.GetAddress,
  //       GetCip1852DerivationSpecific: deps.GetCip1852DerivationSpecific,
  //     },
  //     undefined,
  //   );
  //   for (const address of addrResponse) {
  //     accountingAddresses.push(address.addr);
  //   }
  // }

  return {
    utxoAddresses,
    accountingAddresses,
  };
}

export async function updateCutoffFromInsert(
  tx: lf$Transaction,
  deps: {|
    GetPathWithSpecific: Class<GetPathWithSpecific>,
    GetDerivationSpecific: Class<GetDerivationSpecific>,
    GetDerivationsByPath: Class<GetDerivationsByPath>,
    ModifyDisplayCutoff: Class<ModifyDisplayCutoff>,
  |},
  request: {|
    publicDeriverLevel: number,
    displayCutoffInstance: IDisplayCutoff,
    tree: TreeInsert<any>,
  |},
  derivationTables: Map<number, string>,
): Promise<void> {
  if (request.displayCutoffInstance != null) {
    if (request.publicDeriverLevel !== Bip44DerivationLevels.ACCOUNT.level) {
      throw new Error('updateCutoffFromInsert incorrect pubderiver level');
    }
    const external = request.tree.find(node => node.index === EXTERNAL);
    if (external == null || external.children == null) {
      throw new Error('updateCutoffFromInsert should never happen');
    }
    let bestNewCuttoff = 0;
    for (const child of external.children) {
      if (child.index > bestNewCuttoff) {
        bestNewCuttoff = child.index;
      }
    }

    const currentCutoff = await request.displayCutoffInstance.rawGetCutoff(
      tx,
      {
        GetPathWithSpecific: deps.GetPathWithSpecific,
        GetDerivationSpecific: deps.GetDerivationSpecific,
      },
      undefined,
      derivationTables,
    );
    if (bestNewCuttoff - BIP44_SCAN_SIZE > currentCutoff) {
      await request.displayCutoffInstance.rawSetCutoff(
        tx,
        {
          ModifyDisplayCutoff: deps.ModifyDisplayCutoff,
          GetDerivationsByPath: deps.GetDerivationsByPath,
        },
        { newIndex: bestNewCuttoff - BIP44_SCAN_SIZE },
      );
    }
  }
}