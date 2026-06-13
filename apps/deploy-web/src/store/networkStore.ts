import { NetworkStore } from "@akashnetwork/network-store";

import { browserEnvConfig } from "@src/config/browser-env.config";
import { store } from "@src/store/global-store";
import { withBasePath } from "@src/utils/basePath";

export default NetworkStore.create({
  defaultNetworkId: browserEnvConfig.NEXT_PUBLIC_DEFAULT_NETWORK_ID,
  apiBaseUrl: withBasePath("/api"),
  store
});
