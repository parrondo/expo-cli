import ora from 'ora';
import { getConfig } from '@expo/config';
import { ApiV2, Project, UserManager } from '@expo/xdl';
import { Command } from 'commander';
import log from '../log';
import prompt from '../prompt';
import * as table from '../commands/utils/cli-table';
import {
  Publication,
  getPublishHistoryAsync,
  printPublishDetailsAsync,
  setPublishToChannelAsync,
} from './utils/PublishUtils';

export default function(program: Command) {
  program
    .command('publish:set [project-dir]')
    .alias('ps')
    .description('Set a published release to be served from a specified channel.')
    .option(
      '-c, --release-channel <channel-name>',
      'The channel to set the published release. (Required)'
    )
    .option(
      '-p, --publish-id <publish-id>',
      'The id of the published release to serve from the channel. (Required)'
    )
    .asyncActionProjectDir(
      async (
        projectDir: string,
        options: { releaseChannel?: string; publishId?: string }
      ): Promise<void> => {
        if (!options.releaseChannel) {
          throw new Error('You must specify a release channel.');
        }
        if (!options.publishId) {
          throw new Error('You must specify a publish id. You can find ids using publish:history.');
        }
        try {
          const result = await setPublishToChannelAsync(
            projectDir,
            options as { releaseChannel: string; publishId: string }
          );
          let tableString = table.printTableJson(
            result.queryResult,
            'Channel Set Status ',
            'SUCCESS'
          );
          console.log(tableString);
        } catch (e) {
          log.error(e);
        }
      }
    );
  program
    .command('publish:rollback [project-dir]')
    .alias('pr')
    .description('Rollback an update to a channel.')
    .option('--channel-id <channel-id>', 'The channel id to rollback in the channel. (Required)')
    .asyncActionProjectDir(
      async (projectDir: string, options: { channelId?: string }): Promise<void> => {
        if (!options.channelId) {
          throw new Error('You must specify a channel id. You can find ids using publish:history.');
        }
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
        }

        const mostRecent = history[0];
        const secondMostRecent = history[history.length - 1];

        // the channel entry we want to roll back is the most recent thing in history
        if (mostRecent.channelId === options.channelId) {
          if (history.length === 1) {
            throw new Error(
              `There is no commit of the same sdkVersion (${sdkVersion}) and platform (${platform})for users to receive if we rollback`
            );
          }

          // confirm that users will be receiving the secondMostRecent item in the Publish history
          await printAndConfirm(projectDir, channel, secondMostRecent);

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
          await printAndConfirm(projectDir, channel, mostRecent);
        }

        // rollback channel entry
        const rollbackProgress = ora(
          `Rolling back entry (channel id ${options.channelId})`
        ).start();
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
          log.error(e);
        }
      }
    );
}

async function printAndConfirm(projectDir: string, channel: string, channelEntry: Publication) {
  await printPublishDetailsAsync(projectDir, { publishId: channelEntry.publicationId });

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
