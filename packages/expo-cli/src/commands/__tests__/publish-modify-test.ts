import { vol } from 'memfs';
import { ApiV2 } from '@expo/xdl';

import {
  rollbackPublicationFromChannelAsync,
  setPublishToChannelAsync,
} from '../utils/PublishUtils';

jest.mock('fs');
jest.mock('resolve-from');
jest.mock('ora', () =>
  jest.fn(() => {
    return {
      start: jest.fn(() => {
        return { stop: jest.fn(), succeed: jest.fn() };
      }),
    };
  })
);
jest.mock('@expo/xdl', () => {
  const user = {
    kind: 'user',
    username: 'test-username',
    nickname: 'test-nickname',
    userId: 'test-id',
    picture: 'test-pic',
    currentConnection: 'Username-Password-Authentication',
    sessionSecret: 'test-session-secret',
  };
  const pkg = jest.requireActual('@expo/xdl');
  pkg.UserManager.getCurrentUserAsync = jest.fn(() => user);
  pkg.ApiV2.clientForUser = jest.fn();
  return pkg;
});

describe('publish details', () => {
  const projectRoot = '/test-project';
  const packageJson = JSON.stringify(
    {
      name: 'testing123',
      version: '0.1.0',
      description: 'fake description',
      main: 'index.js',
    },
    null,
    2
  );
  const appJson = JSON.stringify({
    name: 'testing 123',
    version: '0.1.0',
    slug: 'testing-123',
    sdkVersion: '33.0.0',
    owner: 'test-user',
  });

  beforeAll(() => {
    vol.fromJSON({
      [projectRoot + '/package.json']: packageJson,
      [projectRoot + '/app.json']: appJson,
    });
  });

  afterAll(() => {
    vol.reset();
  });

  const originalWarn = console.warn;
  const originalLog = console.log;
  beforeAll(() => {
    console.warn = jest.fn();
    console.log = jest.fn();
  });
  afterAll(() => {
    console.warn = originalWarn;
    console.log = originalLog;
  });

  it('Set publication to channel', async () => {
    const setOptions = {
      releaseChannel: 'test-channel',
      publishId: 'test-uuid',
    };
    const postAsync = jest.fn((methodName, data) => {
      return {};
    });
    (ApiV2.clientForUser as jest.Mock).mockReturnValue({ postAsync });

    await setPublishToChannelAsync(projectRoot, setOptions);

    expect(postAsync.mock.calls.length).toBe(1);
    expect(postAsync).toHaveBeenCalledWith('publish/set', {
      releaseChannel: 'test-channel',
      slug: 'testing-123',
      publishId: 'test-uuid',
    });
  });

  it('rollback publication with bad channelId', async () => {
    const rollbackOptions = {
      channelId: 'test-uuid',
      parent: { nonInteractive: true },
    };
    const postAsync = jest.fn((methodName, data) => {
      if (methodName === 'publish/channel-details')
        return { queryResult: { errorCode: 'channel doesnt exist' } };

      return {};
    });
    (ApiV2.clientForUser as jest.Mock).mockReturnValue({ postAsync });

    try {
      await rollbackPublicationFromChannelAsync(projectRoot, rollbackOptions);
    } catch (e) {
      expect(e).toEqual(new Error('The channel id test-uuid could not be found'));
    }

    expect(postAsync.mock.calls.length).toBe(1);

    expect(postAsync).toHaveBeenCalledWith('publish/channel-details', {
      slug: 'testing-123',
      channelId: 'test-uuid',
      owner: 'test-user',
    });
  });

  it('rollback publication with limited history', async () => {
    const rollbackOptions = {
      channelId: 'test-uuid',
      parent: { nonInteractive: true },
    };
    const postAsync = jest.fn((methodName, data) => {
      if (methodName === 'publish/channel-details')
        return { queryResult: { channel: 'test-channel', platform: 'ios', sdkVersion: '35.0.0' } };
      if (methodName === 'publish/history')
        return {
          queryResult: [{ channelId: 'test-uuid', publicationId: 'test-publication-uuid' }],
        };

      return {};
    });
    (ApiV2.clientForUser as jest.Mock).mockReturnValue({ postAsync });

    try {
      await rollbackPublicationFromChannelAsync(projectRoot, rollbackOptions);
    } catch (e) {
      expect(e).toEqual(
        new Error(
          'There is no publication assigned to channel test-channel with the same sdkVersion (35.0.0) and platform (ios) for users to receive if we rollback'
        )
      );
    }

    expect(postAsync.mock.calls.length).toBe(2);

    expect(postAsync).toHaveBeenCalledWith('publish/channel-details', {
      slug: 'testing-123',
      channelId: 'test-uuid',
      owner: 'test-user',
    });

    expect(postAsync).toHaveBeenCalledWith('publish/history', {
      releaseChannel: 'test-channel',
      slug: 'testing-123',
      count: 2,
      owner: 'test-user',
      platform: 'ios',
      sdkVersion: '35.0.0',
      version: 2,
    });
  });

  it('rollback publication from channel when publication is the most recent thing in history', async () => {
    const rollbackOptions = {
      channelId: 'test-uuid',
      parent: { nonInteractive: true },
    };
    const postAsync = jest.fn((methodName, data) => {
      if (methodName === 'publish/channel-details')
        return { queryResult: { channel: 'test-channel', platform: 'ios', sdkVersion: '35.0.0' } };
      if (methodName === 'publish/history')
        return {
          queryResult: [
            { channelId: 'test-uuid', publicationId: 'test-publication-uuid' },
            { channelId: 'test-uuid-1', publicationId: 'test-publication-uuid-1' },
          ],
        };
      if (methodName === 'publish/details') return { queryResult: { manifest: {} } };
      if (methodName === 'publish/rollback') return { queryResult: {} };

      return {};
    });
    (ApiV2.clientForUser as jest.Mock).mockReturnValue({ postAsync });

    await rollbackPublicationFromChannelAsync(projectRoot, rollbackOptions);

    expect(postAsync.mock.calls.length).toBe(5);
    expect(postAsync).toHaveBeenCalledWith('publish/channel-details', {
      slug: 'testing-123',
      channelId: 'test-uuid',
      owner: 'test-user',
    });
    expect(postAsync).toHaveBeenCalledWith('publish/history', {
      releaseChannel: 'test-channel',
      slug: 'testing-123',
      count: 2,
      owner: 'test-user',
      platform: 'ios',
      sdkVersion: '35.0.0',
      version: 2,
    });
    expect(postAsync).toHaveBeenCalledWith('publish/details', {
      slug: 'testing-123',
      publishId: 'test-publication-uuid-1',
      owner: 'test-user',
    });
    expect(postAsync).toHaveBeenCalledWith('publish/set', {
      slug: 'testing-123',
      publishId: 'test-publication-uuid-1',
      releaseChannel: 'test-channel',
    });
    expect(postAsync).toHaveBeenCalledWith('publish/rollback', {
      channelId: 'test-uuid',
      slug: 'testing-123',
    });
  });

  it('rollback publication from channel when publication is not the most recent thing in history', async () => {
    const rollbackOptions = {
      channelId: 'test-uuid',
      parent: { nonInteractive: true },
    };
    const postAsync = jest.fn((methodName, data) => {
      if (methodName === 'publish/channel-details')
        return { queryResult: { channel: 'test-channel', platform: 'ios', sdkVersion: '35.0.0' } };
      if (methodName === 'publish/history')
        return {
          queryResult: [
            { channelId: 'test-uuid-1', publicationId: 'test-publication-uuid-1' },
            { channelId: 'test-uuid', publicationId: 'test-publication-uuid' },
          ],
        };
      if (methodName === 'publish/details') return { queryResult: { manifest: {} } };
      if (methodName === 'publish/rollback') return { queryResult: {} };

      return {};
    });
    (ApiV2.clientForUser as jest.Mock).mockReturnValue({ postAsync });

    await rollbackPublicationFromChannelAsync(projectRoot, rollbackOptions);

    expect(postAsync.mock.calls.length).toBe(4);
    expect(postAsync).toHaveBeenCalledWith('publish/channel-details', {
      slug: 'testing-123',
      channelId: 'test-uuid',
      owner: 'test-user',
    });
    expect(postAsync).toHaveBeenCalledWith('publish/history', {
      releaseChannel: 'test-channel',
      slug: 'testing-123',
      count: 2,
      owner: 'test-user',
      platform: 'ios',
      sdkVersion: '35.0.0',
      version: 2,
    });
    expect(postAsync).toHaveBeenCalledWith('publish/details', {
      slug: 'testing-123',
      publishId: 'test-publication-uuid-1',
      owner: 'test-user',
    });
    expect(postAsync).toHaveBeenCalledWith('publish/rollback', {
      channelId: 'test-uuid',
      slug: 'testing-123',
    });
  });
});
