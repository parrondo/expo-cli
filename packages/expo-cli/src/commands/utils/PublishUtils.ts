import { getConfig } from '@expo/config';
import { Api, ApiV2, FormData, Project, UserManager } from '@expo/xdl';
import dateFormat from 'dateformat';
import * as table from './cli-table';

export type HistoryOptions = {
  releaseChannel?: string;
  count?: number;
  platform?: 'android' | 'ios';
  raw?: boolean;
  sdkVersion?: string;
};

export type DetailOptions = {
  publishId?: string;
  raw?: boolean;
};

export type Publication = {
  fullName: string;
  channel: string;
  channelId: string;
  publicationId: string;
  appVersion: string;
  sdkVersion: string;
  publishedTime: string;
  platform: 'android' | 'ios';
};

const VERSION = 2;

export async function getPublishHistoryAsync(
  projectDir: string,
  options: HistoryOptions
): Promise<any> {
  if (options.count && (isNaN(options.count) || options.count < 1 || options.count > 100)) {
    throw new Error('-n must be a number between 1 and 100 inclusive');
  }

  // TODO(ville): handle the API result for not authenticated user instead of checking upfront
  const user = await UserManager.ensureLoggedInAsync();
  const { exp } = getConfig(projectDir, {
    skipSDKVersionRequirement: true,
  });

  let result: any;
  if (process.env.EXPO_LEGACY_API === 'true') {
    // TODO(ville): move request from multipart/form-data to JSON once supported by the endpoint.
    let formData = new FormData();
    formData.append('queryType', 'history');
    if (exp.owner) {
      formData.append('owner', exp.owner);
    }
    formData.append('slug', await Project.getSlugAsync(projectDir));
    formData.append('version', VERSION);
    if (options.releaseChannel) {
      formData.append('releaseChannel', options.releaseChannel);
    }
    if (options.count) {
      formData.append('count', options.count);
    }
    if (options.platform) {
      formData.append('platform', options.platform);
    }
    if (options.sdkVersion) {
      formData.append('sdkVersion', options.sdkVersion);
    }

    result = await Api.callMethodAsync('publishInfo', [], 'post', null, {
      formData,
    });
  } else {
    const api = ApiV2.clientForUser(user);
    result = await api.postAsync('publish/history', {
      owner: exp.owner,
      slug: await Project.getSlugAsync(projectDir),
      version: VERSION,
      releaseChannel: options.releaseChannel,
      count: options.count,
      platform: options.platform,
      sdkVersion: options.sdkVersion,
    });
  }
  return result;
}

export async function setPublishToChannelAsync(
  projectDir: string,
  options: { releaseChannel: string; publishId: string }
): Promise<any> {
  const user = await UserManager.ensureLoggedInAsync();
  const api = ApiV2.clientForUser(user);
  return await api.postAsync('publish/set', {
    releaseChannel: options.releaseChannel,
    publishId: options.publishId,
    slug: await Project.getSlugAsync(projectDir),
  });
}

export async function printPublishDetailsAsync(projectDir: string, options: DetailOptions) {
  // TODO(ville): handle the API result for not authenticated user instead of checking upfront
  const user = await UserManager.ensureLoggedInAsync();
  const { exp } = getConfig(projectDir, {
    skipSDKVersionRequirement: true,
  });
  const slug = await Project.getSlugAsync(projectDir);

  let result: any;
  if (process.env.EXPO_LEGACY_API === 'true') {
    let formData = new FormData();
    formData.append('queryType', 'details');

    if (exp.owner) {
      formData.append('owner', exp.owner);
    }
    formData.append('publishId', options.publishId);
    formData.append('slug', slug);

    result = await Api.callMethodAsync('publishInfo', null, 'post', null, {
      formData,
    });
  } else {
    const api = ApiV2.clientForUser(user);
    result = await api.postAsync('publish/details', {
      owner: exp.owner,
      publishId: options.publishId,
      slug,
    });
  }

  if (options.raw) {
    console.log(JSON.stringify(result));
    return;
  }

  if (result.queryResult) {
    let queryResult = result.queryResult;
    let manifest = queryResult.manifest;
    delete queryResult.manifest;

    // Print general release info
    let generalTableString = table.printTableJson(queryResult, 'Release Description');
    console.log(generalTableString);

    // Print manifest info
    let manifestTableString = table.printTableJson(manifest, 'Manifest Details');
    console.log(manifestTableString);
  } else {
    throw new Error('No records found matching your query.');
  }
}
