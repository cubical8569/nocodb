import View from '../../models/View';
import Base from '../../models/Base';
import Model from '../../models/Model';
import NcConnectionMgrv2 from '../../utils/common/NcConnectionMgrv2';
import getAst from '../../db/sql-data-mapper/lib/sql/helpers/getAst';
import { PagedResponseImpl } from '../../meta/helpers/PagedResponse';
import { nocoExecute } from 'nc-help';
import { populateSingleQuery } from './pgQuery';
import { Request } from 'express';

export async function getDataList(
  model: Model,
  view: View,
  req: Request
): Promise<PagedResponseImpl<any>> {
  const base = await Base.get(model.base_id);

  const baseModel = await Model.getBaseModelSQL({
    id: model.id,
    viewId: view?.id,
    dbDriver: NcConnectionMgrv2.get(base)
  });

  let data;
  let count;
  const listArgs: any = { ...req.query };
  try {
    listArgs.filterArr = JSON.parse(listArgs.filterArrJson);
  } catch (e) {}
  try {
    listArgs.sortArr = JSON.parse(listArgs.sortArrJson);
  } catch (e) {}

  if (
    (true || process.env.NC_PG_OPTIMISE || req?.headers?.['nc-pg-optimise']) &&
    base.type === 'pg'
  ) {
    const out = await populateSingleQuery({
      view,
      model,
      base,
      params: listArgs
    });
    count = +out.count;
    data = out.data;
  } else {
    const requestObj = await getAst({ model, query: req.query, view });

    const rootData = await baseModel.list(listArgs);

    data = await nocoExecute(requestObj, rootData, {}, listArgs);

    count = await baseModel.count(listArgs);
  }

  return new PagedResponseImpl(data, {
    ...req.query,
    count
  });
}
