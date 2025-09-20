//===================================//
import { DEFAULT_CONNECTION_CONFIG } from '../Defaults/index.js';
import { makeCommunitiesSocket } from './communities.js';
//===================================//
const makeWASocket = (config) => {
  const newConfig = {
    ...DEFAULT_CONNECTION_CONFIG,
    ...config
  };
  if (config.shouldSyncHistoryMessage === undefined) {
    newConfig.shouldSyncHistoryMessage = () => !!newConfig.syncFullHistory;
  }
  return makeCommunitiesSocket(newConfig);
};
export default makeWASocket;
//===================================//