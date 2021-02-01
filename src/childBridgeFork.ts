/**
 * This is a standalone script executed as a child process fork
 */
process.title = "homebridge: child bridge";

// registering node-source-map-support for typescript stack traces
import "source-map-support/register"; 

import { AccessoryPlugin, HomebridgeAPI, PlatformPlugin, PluginType } from "./api";
import { Plugin } from "./plugin";
import { PluginManager } from "./pluginManager";
import { Logger } from "./logger";
import { User } from "./user";
import { HAPStorage } from "hap-nodejs";
import {
  ChildProcessMessageEventType,
  ChildProcessMessageEvent,
  ChildProcessLoadEventData,
} from "./childBridgeService";
import {
  AccessoryConfig,
  BridgeConfiguration,
  BridgeOptions,
  BridgeService,
  HomebridgeConfig,
  PlatformConfig,
} from "./bridgeService";

export class ChildBridgeFork {
  private bridgeService!: BridgeService;
  private api!: HomebridgeAPI;
  private pluginManager!: PluginManager;

  private type!: PluginType;
  private plugin!: Plugin;
  private identifier!: string;
  private pluginConfig!: PlatformConfig | AccessoryConfig;
  private bridgeConfig!: BridgeConfiguration;
  private bridgeOptions!: BridgeOptions;
  private homebridgeConfig!: HomebridgeConfig;

  constructor() {
    // tell the parent process we are ready to accept plugin config
    this.sendMessage(ChildProcessMessageEventType.READY);
  }

  sendMessage<T = unknown>(type: ChildProcessMessageEventType, data?: T): void {
    if (process.send) {
      process.send({
        id: type,
        data,
      });
    }
  }

  loadPlugin(data: ChildProcessLoadEventData): void {
    // set data
    this.type = data.type;
    this.identifier = data.identifier;
    this.pluginConfig = data.pluginConfig;
    this.bridgeConfig = data.bridgeConfig;
    this.bridgeOptions = data.bridgeOptions;
    this.homebridgeConfig = data.homebridgeConfig;

    // remove the _bridge key (some plugins do not like unknown config)
    delete this.pluginConfig._bridge;

    // set bridge settings (inherited from main bridge)
    if (this.bridgeOptions.noLogTimestamps) {
      Logger.setTimestampEnabled(false);
    }

    if (this.bridgeOptions.debugModeEnabled) {
      Logger.setDebugEnabled(true);
    }

    if (this.bridgeOptions.forceColourLogging) {
      Logger.forceColor();
    }

    if (this.bridgeOptions.customStoragePath) {
      User.setStoragePath(this.bridgeOptions.customStoragePath);
    }

    // Initialize HAP-NodeJS with a custom persist directory
    HAPStorage.setCustomStoragePath(User.persistPath());

    // load api
    this.api = new HomebridgeAPI();
    this.pluginManager = new PluginManager(this.api);

    // load plugin
    this.plugin = this.pluginManager.loadPlugin(data.pluginPath);
    this.plugin.load();
    this.pluginManager.initializePlugin(this.plugin, data.identifier);

    // change process title to include plugin name
    process.title = `homebridge: ${this.plugin.getPluginIdentifier()}`;

    this.sendMessage(ChildProcessMessageEventType.LOADED);
  }

  async startBridge(): Promise<void> {
    this.bridgeService = new BridgeService(
      this.api,
      this.pluginManager,
      this.bridgeOptions,
      this.bridgeConfig,
      this.homebridgeConfig,
    );

    // load the cached accessories
    await this.bridgeService.loadCachedPlatformAccessoriesFromDisk();

    if (this.type === PluginType.PLATFORM) {
      const plugin = this.pluginManager.getPluginForPlatform(this.identifier);
      const displayName = this.pluginConfig?.name || plugin.getPluginIdentifier();
      const logger = Logger.withPrefix(displayName);
      const constructor = plugin.getPlatformConstructor(this.identifier);
      const platform: PlatformPlugin = new constructor(logger, this.pluginConfig as PlatformConfig, this.api);

      if (HomebridgeAPI.isDynamicPlatformPlugin(platform)) {
        plugin.assignDynamicPlatform(this.identifier, platform);
      } else if (HomebridgeAPI.isStaticPlatformPlugin(platform)) { // Plugin 1.0, load accessories
        await this.bridgeService.loadPlatformAccessories(plugin, platform, this.identifier, logger);
      } else {
        // otherwise it's a IndependentPlatformPlugin which doesn't expose any methods at all.
        // We just call the constructor and let it be enabled.
      }

    } else if (this.type === PluginType.ACCESSORY) {
      const plugin = this.pluginManager.getPluginForAccessory(this.identifier);
      const displayName = this.pluginConfig.name;

      if (!displayName) {
        Logger.internal.warn("Could not load accessory %s as it is missing the required 'name' property!", this.identifier);
        return;
      }

      const logger = Logger.withPrefix(displayName);
      const constructor = plugin.getAccessoryConstructor(this.identifier);
      const accessoryInstance: AccessoryPlugin = new constructor(logger, this.pluginConfig as AccessoryConfig, this.api);

      //pass accessoryIdentifier for UUID generation, and optional parameter uuid_base which can be used instead of displayName for UUID generation
      const accessory = this.bridgeService.createHAPAccessory(plugin, accessoryInstance, displayName, this.identifier, this.pluginConfig.uuid_base);

      if (accessory) {
        this.bridgeService.bridge.addBridgedAccessory(accessory);
      } else {
        logger("Accessory %s returned empty set of services. Won't adding it to the bridge!", this.identifier);
      }
    }

    // restore the cached accessories
    this.bridgeService.restoreCachedPlatformAccessories();

    this.bridgeService.publishBridge();
    this.api.signalFinished();
  }

  shutdown(): void {
    this.bridgeService.teardown();
  }
}

/**
 * Start Self
 */
const childPluginFork = new ChildBridgeFork();

/**
 * Handle incoming IPC messages from the parent Homebridge process
 */
process.on("message", (message: ChildProcessMessageEvent<unknown>) => {
  if (typeof message !== "object" || !message.id) {
    return;
  }

  switch (message.id) {
    case ChildProcessMessageEventType.LOAD: {
      childPluginFork.loadPlugin(message.data as ChildProcessLoadEventData);
      break;
    }
    case ChildProcessMessageEventType.START: {
      childPluginFork.startBridge();
      break;
    }
  }
});

/**
 * Handle the sigterm shutdown signals
 */
let shuttingDown = false;
const signalHandler = (signal: NodeJS.Signals, signalNum: number): void => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  Logger.internal.info("Got %s, shutting down child bridge process...", signal);

  try {
    childPluginFork.shutdown();
  } catch (e) {
    // do nothing
  }
  
  setTimeout(() => process.exit(128 + signalNum), 5000);
};

process.on("SIGINT", signalHandler.bind(undefined, "SIGINT", 2));
process.on("SIGTERM", signalHandler.bind(undefined, "SIGTERM", 15));

/**
 * Ensure orphaned processes are cleaned up
 */
setInterval(() => {
  if (!process.connected) {
    Logger.internal.info("Parent process not connected, terminating process...");
    process.exit(1);
  }
}, 5000);
