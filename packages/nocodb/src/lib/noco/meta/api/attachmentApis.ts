// @ts-ignore
import { Request, Response, Router } from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { Tele } from 'nc-help';
import path from 'path';
import slash from 'slash';
import mimetypes, { mimeIcons } from '../../../utils/mimeTypes';
import ncMetaAclMw from '../helpers/ncMetaAclMw';
import catchError from '../helpers/catchError';
import NcPluginMgrv2 from '../helpers/NcPluginMgrv2';
import Model from '../../../noco-models/Model';
import Project from '../../../noco-models/Project';
import S3 from '../../../../plugins/s3/S3';

// const storageAdapter = new Local();
export async function upload(req: Request, res: Response) {
  const filePath = sanitizeUrlPath(
    req.query?.path?.toString()?.split('/') || ['']
  );
  const destPath = path.join('nc', 'uploads', ...filePath);

  const storageAdapter = await NcPluginMgrv2.storageAdapter();
  const column = await getColumnFromFilePath(filePath);
  const attachments = await Promise.all(
    (req as any).files?.map(async file => {
      const fileName = `${nanoid(6)}${path.extname(file.originalname)}`;
      const relativePath = slash(path.join(destPath, fileName));
      let url = await storageAdapter.fileCreate(
        relativePath,
        file,
        column.public
      );

      if (!url) {
        url = `${(req as any).ncSiteUrl}/download/${filePath.join(
          '/'
        )}/${fileName}`;
      }

      return {
        url,
        title: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        icon: mimeIcons[path.extname(file.originalname).slice(1)] || undefined,
        ...(!column.public ? s3KeyObject(storageAdapter, relativePath) : {})
      };
    })
  );

  Tele.emit('evt', { evt_type: 'image:uploaded' });

  res.json(attachments);
}

export async function fileRead(req, res) {
  try {
    const storageAdapter = await NcPluginMgrv2.storageAdapter();
    // const type = mimetypes[path.extname(req.s.fileName).slice(1)] || 'text/plain';
    const type =
      mimetypes[
        path
          .extname(req.params?.[0])
          .split('/')
          .pop()
          .slice(1)
      ] || 'text/plain';
    // const img = await this.storageAdapter.fileRead(slash(path.join('nc', req.params.projectId, req.params.dbAlias, 'uploads', req.params.fileName)));
    const img = await storageAdapter.fileRead(
      slash(
        path.join(
          'nc',
          'uploads',
          req.params?.[0]
            ?.split('/')
            .filter(p => p !== '..')
            .join('/')
        )
      )
    );
    res.writeHead(200, { 'Content-Type': type });
    res.end(img, 'binary');
  } catch (e) {
    console.log(e);
    res.status(404).send('Not found');
  }
}

async function getColumnFromFilePath(filePath: Array<string>) {
  const [_, projectName, tableName, columnName] = filePath;
  const project = await Project.getWithInfoByTitle(projectName);
  const base = project.bases[0];
  const table = await Model.getByAliasOrId({
    project_id: project.id,
    base_id: base.id,
    aliasOrId: tableName
  });
  const columns = await table.getColumns();
  return columns.filter(column => column.column_name === columnName)[0];
}

function s3KeyObject(storageAdapter, key: string) {
  if (!(storageAdapter instanceof S3)) return {};

  return {
    S3Key: key
  };
}

const router = Router({ mergeParams: true });

router.get(/^\/dl\/([^/]+)\/([^/]+)\/(.+)$/, async (req, res) => {
  try {
    // const type = mimetypes[path.extname(req.params.fileName).slice(1)] || 'text/plain';
    const type =
      mimetypes[
        path
          .extname(req.params[2])
          .split('/')
          .pop()
          .slice(1)
      ] || 'text/plain';

    const storageAdapter = await NcPluginMgrv2.storageAdapter();
    // const img = await this.storageAdapter.fileRead(slash(path.join('nc', req.params.projectId, req.params.dbAlias, 'uploads', req.params.fileName)));
    const img = await storageAdapter.fileRead(
      slash(
        path.join(
          'nc',
          req.params[0],
          req.params[1],
          'uploads',
          ...req.params[2].split('/')
        )
      )
    );
    res.writeHead(200, { 'Content-Type': type });
    res.end(img, 'binary');
  } catch (e) {
    res.status(404).send('Not found');
  }
});

export function sanitizeUrlPath(paths) {
  return paths.map(url => url.replace(/[/.?#]+/g, '_'));
}

router.post(
  '/api/v1/db/storage/upload',
  multer({
    storage: multer.diskStorage({})
  }).any(),
  ncMetaAclMw(upload, 'upload')
);
router.get(/^\/download\/(.+)$/, catchError(fileRead));

export default router;