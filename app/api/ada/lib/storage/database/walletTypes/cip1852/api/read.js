// @flow

import type {
  lf$Database,
  lf$Transaction,
} from 'lovefield';

import type {
  Cip1852WrapperRow,
} from '../tables';
import * as Tables from '../tables';

import {
  getRowFromKey,
} from '../../../utils';
import { PublicDeriverSchema, } from '../../core/tables';
import type { PublicDeriverRow, } from '../../core/tables';

export class GetCip1852Wrapper {
  static ownTables: {|
    Cip1852Wrapper: typeof Tables.Cip1852WrapperSchema,
  |} = Object.freeze({
    [Tables.Cip1852WrapperSchema.name]: Tables.Cip1852WrapperSchema,
  });
  static depTables: {||} = Object.freeze({});

  static async get(
    db: lf$Database,
    tx: lf$Transaction,
    key: number,
  ): Promise<$ReadOnly<Cip1852WrapperRow> | void> {
    return await getRowFromKey<Cip1852WrapperRow>(
      db, tx,
      key,
      GetCip1852Wrapper.ownTables[Tables.Cip1852WrapperSchema.name].name,
      GetCip1852Wrapper.ownTables[Tables.Cip1852WrapperSchema.name].properties.ConceptualWalletId,
    );
  }
}

export class GetAllCip1852Wallets {
  static ownTables: {|
    Cip1852Wrapper: typeof Tables.Cip1852WrapperSchema,
    PublicDeriver: typeof PublicDeriverSchema,
  |} = Object.freeze({
    [Tables.Cip1852WrapperSchema.name]: Tables.Cip1852WrapperSchema,
    [PublicDeriverSchema.name]: PublicDeriverSchema,
  });
  static depTables: {||} = Object.freeze({});

  static async get(
    db: lf$Database,
    tx: lf$Transaction,
  ): Promise<$ReadOnlyArray<{|
    Cip1852Wrapper: $ReadOnly<Cip1852WrapperRow>,
    PublicDeriver: $ReadOnly<PublicDeriverRow>,
  |}>> {
    const publicDeriverTable = db.getSchema().table(
      GetAllCip1852Wallets.ownTables[PublicDeriverSchema.name].name
    );
    const Cip1852WrapperTable = db.getSchema().table(
      GetAllCip1852Wallets.ownTables[Tables.Cip1852WrapperSchema.name].name
    );
    const query = db
      .select()
      .from(Cip1852WrapperTable)
      .innerJoin(
        publicDeriverTable,
        publicDeriverTable[PublicDeriverSchema.properties.ConceptualWalletId].eq(
          Cip1852WrapperTable[PublicDeriverSchema.properties.ConceptualWalletId]
        )
      );

    return await tx.attach(query);
  }
}
