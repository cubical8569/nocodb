import { Request, Response, } from 'express';
import { getViewAndModelFromRequestByAliasOrId } from '../../dataApis/helpers';

import * as dataAliasServices from '../../../../services/ee/data/dataAliasServices';

// todo: Handle the error case where view doesnt belong to model
export async function dataList(req: Request, res: Response) {
  const { model, view } = await getViewAndModelFromRequestByAliasOrId(req);
  res.json(await dataAliasServices.getDataList(model, view, req));
}
