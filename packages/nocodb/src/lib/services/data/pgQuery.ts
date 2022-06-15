import Model from '../../models/Model';
import NcConnectionMgrv2 from '../../utils/common/NcConnectionMgrv2';
import { isSystemColumn, RelationTypes, UITypes } from 'nocodb-sdk';
import {
  extractFilterFromXwhere,
  extractSortsObject,
  getListArgs,
  sanitize
} from '../../db/sql-data-mapper/lib/sql/BaseModelSqlv2';
import genRollupSelectv2 from '../../db/sql-data-mapper/lib/sql/genRollupSelectv2';
import LookupColumn from '../../models/LookupColumn';
import LinkToAnotherRecordColumn from '../../models/LinkToAnotherRecordColumn';
import Column from '../../models/Column';
import { XKnex } from '../../db/sql-data-mapper';
import { QueryBuilder } from 'knex';
import Sort from '../../models/Sort';
import Filter from '../../models/Filter';
import conditionV2 from '../../db/sql-data-mapper/lib/sql/conditionV2';
import sortV2 from '../../db/sql-data-mapper/lib/sql/sortV2';
import FormulaColumn from '../../models/FormulaColumn';
import formulaQueryBuilderv2 from '../../db/sql-data-mapper/lib/sql/formulav2/formulaQueryBuilderv2';
import View from '../../models/View';
import Base from '../../models/Base';

const ROOT_ALIAS = '__nc_root';

let aliasC = 0;

function getAlias() {
  return `__nc_${aliasC++}`;
}

export async function populateSingleQuery(ctx: {
  model: Model;
  view: View;
  base: Base;
  params;
}): Promise<{ count?: number | string; data: any[] }> {
  if (ctx.base.type !== 'pg') {
    new Error('Single query only supported in postgres');
  }

  // get knex connection
  const knex = NcConnectionMgrv2.get(ctx.base);
  // load columns list
  await ctx.model.getColumns();
  const listArgs = getListArgs(ctx.params, ctx.model);

  const rootQb = knex(ctx.model.table_name);
  const countQb = knex(ctx.model.table_name);
  countQb.count({ count: ctx.model.primaryKey?.column_name || '*' });

  const aliasColObjMap = await ctx.model.getAliasColObjMap();
  let sorts = extractSortsObject(listArgs?.sort, aliasColObjMap);
  const queryFilterObj = extractFilterFromXwhere(
    listArgs?.where,
    aliasColObjMap
  );

  if (!sorts?.['length'] && ctx.params.sortArr?.length) {
    sorts = ctx.params.sortArr;
  } else if (ctx.view) {
    sorts = await Sort.list({ viewId: ctx.view.id });
  }

  const aggrConditionObj = [
    new Filter({
      children:
        (await Filter.rootFilterList({
          viewId: await Filter.getFilterObject({ viewId: ctx.view.id })
        })) || [],
      is_group: true
    }),
    new Filter({
      children: ctx.params.filterArr || [],
      is_group: true,
      logical_op: 'and'
    }),
    new Filter({
      children: queryFilterObj,
      is_group: true,
      logical_op: 'and'
    })
  ];

  await conditionV2(aggrConditionObj, rootQb, knex);
  await conditionV2(aggrConditionObj, countQb, knex);
  if (sorts) await sortV2(sorts, rootQb, knex);

  const qb = knex.from(rootQb.as(ROOT_ALIAS));

  let allowedCols = null;
  if (ctx.view)
    allowedCols = (await View.getColumns(ctx.view.id)).reduce(
      (o, c) => ({
        ...o,
        [c.fk_column_id]: c.show
      }),
      {}
    );

  for (const column of await ctx.model.getColumns()) {
    if (allowedCols && !allowedCols[column.id]) continue;
    await extractColumn({
      column,
      knex,
      rootAlias: ROOT_ALIAS,
      qb
    });
  }

  rootQb.limit(+listArgs.limit);
  rootQb.offset(+listArgs.offset);

  const dataAlias = getAlias();

  const finalQb = knex
    .from(qb.as(dataAlias))
    .select(
      knex.raw(`coalesce(json_agg(??.*),'[]'::json) as ??`, [dataAlias, 'data'])
    )
    .select(countQb.as('count'))
    .first();

  const res = await finalQb;

  return res;
}

async function extractColumn({
  column,
  qb,
  rootAlias,
  knex,
  // @ts-ignore
  isLookup
}: {
  column: Column;
  qb: QueryBuilder;
  rootAlias: string;
  knex: XKnex;
  isLookup?: boolean;
}) {
  const result = { isArray: false };
  if (isSystemColumn(column)) return result;
  // const model = await column.getModel();
  switch (column.uidt) {
    case UITypes.LinkToAnotherRecord:
      {
        const relatedModel = await column.colOptions.getRelatedTable();
        await relatedModel.getColumns();
        // @ts-ignore
        const pkColumn = relatedModel.primaryKey;
        const pvColumn = relatedModel.primaryValue;

        switch (column.colOptions.type) {
          case RelationTypes.MANY_TO_MANY:
            {
              result.isArray = true;
              const alias1 = getAlias();
              const alias2 = getAlias();
              const alias3 = getAlias();
              const alias4 = getAlias();

              const parentModel = await column.colOptions.getRelatedTable();
              const mmChildColumn = await column.colOptions.getMMChildColumn();
              const mmParentColumn = await column.colOptions.getMMParentColumn();
              const assocModel = await column.colOptions.getMMModel();
              const childColumn = await column.colOptions.getChildColumn();
              const parentColumn = await column.colOptions.getParentColumn();

              const assocQb = knex(
                knex.raw('?? as ??', [assocModel.table_name, alias1])
              ).whereRaw(`??.?? = ??.??`, [
                alias1,
                mmChildColumn.column_name,
                rootAlias,
                childColumn.column_name
              ]);

              const mmQb = knex(assocQb.as(alias4))
                .leftJoin(
                  knex.raw(`?? as ?? on ??.?? = ??.??`, [
                    parentModel.table_name,
                    alias2,
                    alias2,
                    parentColumn.column_name,
                    alias4,
                    mmParentColumn.column_name
                  ])
                )
                .select(knex.raw('??.*', [alias2]));

              qb.joinRaw(
                `LEFT OUTER JOIN LATERAL
                     (${knex
                       .from(mmQb.as(alias3))
                       .select(
                         knex.raw(
                           `coalesce(json_agg(jsonb_build_object(?,??.??, ?, ??.??)),'[]'::json) as ??`,
                           [
                             pvColumn.column_name,
                             alias3,
                             pvColumn.column_name,
                             pkColumn.column_name,
                             alias3,
                             pkColumn.column_name,
                             column.title
                           ]
                         )
                       )
                       .toQuery()}) as ?? ON true`,
                [alias1]
              );

              qb.select(knex.raw('??.??', [alias1, column.title]));
            }
            break;
          case RelationTypes.BELONGS_TO:
            {
              const alias1 = getAlias();
              const alias2 = getAlias();

              const parentModel = await column.colOptions.getRelatedTable();
              const childColumn = await column.colOptions.getChildColumn();
              const parentColumn = await column.colOptions.getParentColumn();
              const btQb = knex(parentModel.table_name)
                .select('*')
                .where(
                  parentColumn.column_name,
                  knex.raw('??.??', [rootAlias, childColumn.column_name])
                );
              qb.joinRaw(
                `LEFT OUTER JOIN LATERAL
                     (${knex
                       .from(btQb.as(alias2))
                       .select(
                         knex.raw(
                           `json_build_object(?,??.??, ?, ??.??) as ??`,
                           [
                             pvColumn.column_name,
                             alias2,
                             pvColumn.column_name,
                             pkColumn.column_name,
                             alias2,
                             pkColumn.column_name,
                             column.title
                           ]
                         )
                       )
                       .toQuery()}) as ?? ON true`,
                [alias1]
              );

              qb.select(knex.raw('??.??', [alias1, column.title]));
            }
            break;
          case RelationTypes.HAS_MANY:
            {
              result.isArray = true;
              const alias1 = getAlias();
              const alias2 = getAlias();

              const childModel = await column.colOptions.getRelatedTable();
              const childColumn = await column.colOptions.getChildColumn();
              const parentColumn = await column.colOptions.getParentColumn();
              const hmQb = knex(childModel.table_name)
                .select('*')
                .where(
                  childColumn.column_name,
                  knex.raw('??.??', [rootAlias, parentColumn.column_name])
                );

              qb.joinRaw(
                `LEFT OUTER JOIN LATERAL
                     (${knex
                       .from(hmQb.as(alias2))
                       .select(
                         knex.raw(
                           `coalesce(json_agg(jsonb_build_object(?,??.??, ?, ??.??)),'[]'::json) as ??`,
                           [
                             pvColumn.column_name,
                             alias2,
                             pvColumn.column_name,
                             pkColumn.column_name,
                             alias2,
                             pkColumn.column_name,
                             column.title
                           ]
                         )
                       )
                       .toQuery()}) as ?? ON true`,
                [alias1]
              );
              qb.select(knex.raw('??.??', [alias1, column.title]));
            }
            break;
        }
      }
      break;
    case UITypes.Lookup:
      {
        const alias2 = getAlias();
        const lookupTableAlias = getAlias();

        const lookupColOpt = await column.getColOptions<LookupColumn>();
        const lookupColumn = await lookupColOpt.getLookupColumn();

        const relationColumn = await lookupColOpt.getRelationColumn();
        const relationColOpts = await relationColumn.getColOptions<
          LinkToAnotherRecordColumn
        >();
        let relQb;
        const relTableAlias = getAlias();

        switch (relationColOpts.type) {
          case RelationTypes.MANY_TO_MANY:
            {
              result.isArray = true;

              const alias1 = getAlias();
              const alias4 = getAlias();

              const parentModel = await relationColOpts.getRelatedTable();
              const mmChildColumn = await relationColOpts.getMMChildColumn();
              const mmParentColumn = await relationColOpts.getMMParentColumn();
              const assocModel = await relationColOpts.getMMModel();
              const childColumn = await relationColOpts.getChildColumn();
              const parentColumn = await relationColOpts.getParentColumn();

              const assocQb = knex(
                knex.raw('?? as ??', [assocModel.table_name, alias1])
              ).whereRaw(`??.?? = ??.??`, [
                alias1,
                mmChildColumn.column_name,
                rootAlias,
                childColumn.column_name
              ]);

              relQb = knex(assocQb.as(alias4)).leftJoin(
                knex.raw(`?? as ?? on ??.?? = ??.??`, [
                  parentModel.table_name,
                  relTableAlias,
                  relTableAlias,
                  parentColumn.column_name,
                  alias4,
                  mmParentColumn.column_name
                ])
              );
            }
            break;
          case RelationTypes.BELONGS_TO:
            {
              // if (aliasC) break
              // const alias2 = getAlias();

              const parentModel = await relationColOpts.getRelatedTable();
              const childColumn = await relationColOpts.getChildColumn();
              const parentColumn = await relationColOpts.getParentColumn();
              relQb = knex(
                knex.raw('?? as ??', [parentModel.table_name, relTableAlias])
              ).where(
                parentColumn.column_name,
                knex.raw('??.??', [rootAlias, childColumn.column_name])
              );
            }
            break;
          case RelationTypes.HAS_MANY:
            {
              result.isArray = true;
              const childModel = await relationColOpts.getRelatedTable();
              const childColumn = await relationColOpts.getChildColumn();
              const parentColumn = await relationColOpts.getParentColumn();
              relQb = knex(
                knex.raw('?? as ??', [childModel.table_name, relTableAlias])
              ).where(
                childColumn.column_name,
                knex.raw('??.??', [rootAlias, parentColumn.column_name])
              );
            }

            break;
        }

        const { isArray } = await extractColumn({
          qb: relQb,
          rootAlias: relTableAlias,
          knex,
          column: lookupColumn
        });

        if (!result.isArray) {
          qb.joinRaw(
            `LEFT OUTER JOIN LATERAL
               (${knex
                 .from(relQb.as(alias2))
                 .select(
                   knex.raw(`??.?? as ??`, [
                     alias2,
                     lookupColumn.title,
                     column.title
                   ])
                 )
                 .toQuery()}) as ?? ON true`,
            [lookupTableAlias]
          );
        } else if (isArray) {
          const alias = getAlias();
          qb.joinRaw(
            `LEFT OUTER JOIN LATERAL
               (${knex
                 .from(relQb.as(alias2))
                 .select(
                   knex.raw(`coalesce(json_agg(??),'[]'::json) as ??`, [
                     alias,
                     column.title
                   ])
                 )
                 .toQuery()},json_array_elements(??.??) as ?? ) as ?? ON true`,
            [alias2, lookupColumn.title, alias, lookupTableAlias]
          );
        } else {
          qb.joinRaw(
            `LEFT OUTER JOIN LATERAL
               (${knex
                 .from(relQb.as(alias2))
                 .select(
                   knex.raw(`coalesce(json_agg(??.??),'[]'::json) as ??`, [
                     alias2,
                     lookupColumn.title,
                     column.title
                   ])
                 )
                 .toQuery()}) as ?? ON true`,
            [lookupTableAlias]
          );
        }
        qb.select(knex.raw('??.??', [lookupTableAlias, column.title]));
      }
      break;
    case UITypes.Formula:
      {
        const model: Model = await column.getModel();
        const formula = await column.getColOptions<FormulaColumn>();
        if (formula.error) return result;
        const selectQb = await formulaQueryBuilderv2(
          formula.formula,
          null,
          knex,
          model
        );
        qb.select(
          knex.raw(`?? as ??`, [selectQb.builder, sanitize(column.title)])
        );
      }
      break;
    case UITypes.Rollup:
      qb.select(
        (
          await genRollupSelectv2({
            knex,
            columnOptions: await column.getColOptions(),
            alias: rootAlias
          })
        ).builder.as(sanitize(column.title))
      );
      break;
    default:
      {
        qb.select(
          knex.raw(`??.?? as ??`, [rootAlias, column.column_name, column.title])
        );
      }
      break;
  }
  return result;
}
