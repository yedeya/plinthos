import { RDSDataClient, type ExecuteStatementCommandInput } from '@aws-sdk/client-rds-data';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgNumericBigInt, PgNumericNumber, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { connectDatabase } from '../../src/db/client';
import * as schema from '../../src/db/schema';
import { priceQuote } from '../../src/db/schema/price-quote';

/**
 * The Data API binds a parameter as text unless it carries a type hint, and PostgreSQL refuses
 * text in a numeric column (SQLSTATE 42804). Drizzle hints only the string-mode numeric column,
 * so `connectDatabase` hints the number modes too. The TCP driver the other tests use never
 * shows this, so this test watches the statements a fake Data API client receives.
 */

function fakeDataApi() {
  const statements: ExecuteStatementCommandInput[] = [];
  // A real client, so Drizzle takes it as one, whose every call is answered here instead of sent.
  const client = new RDSDataClient({ region: 'eu-central-1', credentials: { accessKeyId: 'made-up', secretAccessKey: 'made-up' } });
  client.send = (async (command: { input: ExecuteStatementCommandInput }) => {
    statements.push(command.input);
    return { numberOfRecordsUpdated: 1, records: [] };
  }) as unknown as RDSDataClient['send'];
  const db = connectDatabase({ clusterArn: 'arn:aws:rds:eu-central-1:000000000000:cluster:made-up', secretArn: 'arn:aws:secretsmanager:eu-central-1:000000000000:secret:made-up', database: 'plinthos' }, { client });
  return { db, statements };
}

function hintOf(statement: ExecuteStatementCommandInput | undefined, value: string) {
  const parameter = statement?.parameters?.find((p) => p.value?.stringValue === value);
  expect(parameter, `a parameter holding ${value}`).toBeDefined();
  return parameter?.typeHint;
}

const numberColumns = Object.values(schema as Record<string, unknown>)
  .filter((table): table is PgTable => is(table, PgTable))
  .flatMap((table) =>
    Object.entries(getTableColumns(table))
      .filter(([, column]) => is(column, PgNumericNumber) || is(column, PgNumericBigInt))
      .map(([key, column]) => ({ table, key, name: `${getTableName(table)}.${column.name}` })),
  );

describe('numeric parameters over the Data API', () => {
  it('[PLAT-9] finds the number-mode numeric columns: prices, values, overrides and asking prices', () => {
    expect(numberColumns.map((c) => c.name)).toEqual(expect.arrayContaining(['price_quote.average', 'collection_item.manual_value_override', 'parts_lot.unit_price']));
  });

  it.each(numberColumns.map((c) => [c.name, c] as const))('[PLAT-9] sends %s with the DECIMAL hint', async (_name, { table, key }) => {
    const { db, statements } = fakeDataApi();
    await db.update(table).set({ [key]: 12.3456 });
    expect(hintOf(statements.at(-1), '12.3456')).toBe('DECIMAL');
  });

  it('[PLAT-9] sends the refresh\'s quote upsert with the DECIMAL hint, in the values and in the update', async () => {
    const { db, statements } = fakeDataApi();
    const fields = { average: 123.456, sampleSize: 24, currency: 'EUR', source: 'bricklink' as const, fetchedAt: new Date(0), attemptedAt: new Date(0), lastError: null };
    await db
      .insert(priceQuote)
      .values({ itemType: 'SET', itemNo: '10294-1', newOrUsed: 'N', ...fields })
      .onConflictDoUpdate({ target: [priceQuote.itemType, priceQuote.itemNo, priceQuote.newOrUsed], set: fields });
    const averages = statements.at(-1)?.parameters?.filter((p) => p.value?.stringValue === '123.456') ?? [];
    expect(averages).toHaveLength(2);
    for (const parameter of averages) expect(parameter.typeHint).toBe('DECIMAL');
  });
});
