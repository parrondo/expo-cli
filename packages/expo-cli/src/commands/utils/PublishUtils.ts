import { ExpoConfig, getConfig } from '@expo/config';
import { Api, ApiV2, FormData, Project, User, UserManager } from '@expo/xdl';
import dateFormat from 'dateformat';
import ora from 'ora';
import * as table from './cli-table';
import log from '../../log';
import prompt from '../../prompt';

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

export type SetOptions = { releaseChannel: string; publishId: string };

export type RollbackOptions = { channelId: string; parent?: { nonInteractive?: boolean } };

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

export type PublicationDetail = {
  manifest: {
    [key: string]: string;
  };
  publishedTime: string;
  publishingUsername: string;
  packageUsername: string;
  packageName: string;
  fullName: string;
  hash: string;
  sdkVersion: string;
  s3Key: string;
  s3Url: string;
  abiVersion: string | null;
  bundleUrl: string | null;
  platform: string;
  version: string;
  revisionId: string;
  channels: { [key: string]: string }[];
  publicationId: string;
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
  options: SetOptions
): Promise<any> {
  const user = await UserManager.ensureLoggedInAsync();
  const api = ApiV2.clientForUser(user);
  return await api.postAsync('publish/set', {
    releaseChannel: options.releaseChannel,
    publishId: options.publishId,
    slug: await Project.getSlugAsync(projectDir),
  });
}

export async function rollbackPublicationFromChannelAsync(
  projectDir: string,
  options: RollbackOptions
) {
  const user = await UserManager.getCurrentUserAsync();
  const api = ApiV2.clientForUser(user);
  const { exp } = getConfig(projectDir, {
    skipSDKVersionRequirement: true,
  });

  const channelQueryResult = await api.postAsync('publish/channel-details', {
    owner: exp.owner,
    slug: await Project.getSlugAsync(projectDir),
    channelId: options.channelId,
  });

  const { channel, platform, sdkVersion } = channelQueryResult.queryResult;

  if (channelQueryResult.queryResult.errorCode) {
    throw new Error(`The channel id ${options.channelId} could not be found`);
  }

  // get the 2 most recent things in the channel history
  const historyQueryResult = await getPublishHistoryAsync(projectDir, {
    releaseChannel: channel,
    platform,
    sdkVersion,
    count: 2,
  });

  // if the channelId is the most recent thing in the channel history
  const history = historyQueryResult.queryResult as Publication[];
  if (history.length === 0) {
    throw new Error(
      `The channel id ${options.channelId} could not be found in the publish history of channel: ${channel}`
    );
  } else if (history.length === 1) {
    throw new Error(
      `There is no publication assigned to channel ${channel} with the same sdkVersion (${sdkVersion}) and platform (${platform}) for users to receive if we rollback`
    );
  }

  const mostRecent = history[0];
  const secondMostRecent = history[history.length - 1];

  // the channel entry we want to roll back is the most recent thing in history
  if (mostRecent.channelId === options.channelId) {
    // confirm that users will be receiving the secondMostRecent item in the Publish history
    await _printAndConfirm(projectDir, channel, secondMostRecent, options);

    // apply the revert publication to channel
    const revertProgress = ora(`Applying a revert publication to channel ${channel}`).start();
    await setPublishToChannelAsync(projectDir, {
      releaseChannel: channel,
      publishId: secondMostRecent.publicationId,
    });
    revertProgress.succeed(
      'Successfully applied revert publication. You can view it with `publish:history`'
    );
  } else {
    // confirm that users will be receiving the mostRecent item in the Publish history
    await _printAndConfirm(projectDir, channel, mostRecent, options);
  }

  // rollback channel entry
  const rollbackProgress = ora(`Rolling back entry (channel id ${options.channelId})`).start();
  try {
    let result = await api.postAsync('publish/rollback', {
      channelId: options.channelId,
      slug: await Project.getSlugAsync(projectDir),
    });
    rollbackProgress.succeed();
    let tableString = table.printTableJson(
      result.queryResult,
      'Channel Rollback Status ',
      'SUCCESS'
    );
    console.log(tableString);
  } catch (e) {
    rollbackProgress.stop();
    throw e;
  }
}

async function _printAndConfirm(
  projectDir: string,
  channel: string,
  channelEntry: Publication,
  rollbackOptions: RollbackOptions
): Promise<void> {
  const detailOptions = {
    publishId: channelEntry.publicationId,
  };
  const detail = await getPublicationDetailAsync(projectDir, detailOptions);
  await printPublicationDetailAsync(detail, detailOptions);

  if (rollbackOptions.parent && rollbackOptions.parent.nonInteractive) {
    return;
  }
  const { confirm } = await prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: `Users on the '${channel}' channel will receive the above publication as a result of the rollback.`,
    },
  ]);

  if (!confirm) {
    throw new Error(`Please run 'publish:set' to send the desired publication to users`);
  }
}

export async function getPublicationDetailAsync(
  projectDir: string,
  options: DetailOptions
): Promise<PublicationDetail> {
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

  if (!result.queryResult) {
    throw new Error('No records found matching your query.');
  }

  return result.queryResult;
}

export async function printPublicationDetailAsync(
  detail: PublicationDetail,
  options: DetailOptions
) {
  if (options.raw) {
    console.log(JSON.stringify(detail));
    return;
  }

  let manifest = detail.manifest;
  delete detail.manifest;

  // Print general release info
  let generalTableString = table.printTableJson(detail, 'Release Description');
  console.log(generalTableString);

  // Print manifest info
  let manifestTableString = table.printTableJson(manifest, 'Manifest Details');
  console.log(manifestTableString);
}
