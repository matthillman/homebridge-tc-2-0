import {
  Service,
  HAP,
  CharacteristicValue,
  CharacteristicSetCallback,
  CharacteristicGetCallback,
  Logging,
  API,
  AccessoryPlugin,
  AccessoryConfig,
} from "homebridge";
import { convertTCArmStateToHK, HKArmState, TCApi, TCArmState, TCError } from "./tc";

export class TotalConnectAccessory implements AccessoryPlugin {
  private readonly log: Logging;
  private readonly api: API;
  private readonly name: string;

  private readonly securityService: Service;
  private readonly informationService: Service;

  private tc: TCApi;

  private targetState: CharacteristicValue = -1;

  private pollInterval: NodeJS.Timer | undefined;

  constructor(log: Logging, config: AccessoryConfig, api: API) {
    this.log = log;
    this.api = api;
    this.name = config.name;

    this.tc = new TCApi(log, {
      username: config.username as string,
      password: config.password as string,
    });

    this.securityService = new api.hap.Service.SecuritySystem(this.name);

    // set accessory information
    this.informationService = new api.hap.Service.AccessoryInformation()
      .setCharacteristic(api.hap.Characteristic.Manufacturer, "Resideo")
      .setCharacteristic(api.hap.Characteristic.Model, "TotalConnect")
      .setCharacteristic(api.hap.Characteristic.SerialNumber, "2.0")
      .setCharacteristic(api.hap.Characteristic.Name, config.name);

    this.securityService
      .getCharacteristic(api.hap.Characteristic.SecuritySystemCurrentState)
      .on("get", this.getCurrentState.bind(this));

    this.securityService
      .getCharacteristic(api.hap.Characteristic.SecuritySystemTargetState)
      .on("get", this.getTargetState.bind(this))
      .on("set", this.setTargetState.bind(this));

    setInterval(async () => {
      let newState = await this.tc.getFullStatus();
      this.log.info(`AUTO-POLLING state and got ${newState}`);
      if (newState !== TCArmState.unknown) {
        this.targetState = convertTCArmStateToHK(newState);
        this.securityService.updateCharacteristic(
          this.api.hap.Characteristic.SecuritySystemCurrentState,
          this.targetState
        );
        this.securityService.updateCharacteristic(
          this.api.hap.Characteristic.SecuritySystemTargetState,
          this.targetState
        );
      }
    }, 1000 * 60 * 5);

    this.log.debug(`TC Accessory init complete`);
  }

  getServices(): Service[] {
    return [this.informationService, this.securityService];
  }

  async getCurrentState(callback: CharacteristicSetCallback) {
    try {
      const currentState = await this.tc.getFullStatus();
      this.log.info("Get current state ->", currentState, convertTCArmStateToHK(currentState));

      callback(null, convertTCArmStateToHK(currentState));
    } catch (err) {
      if (err instanceof TCError) {
        callback(err);
      }
    }
  }

  async getTargetState(callback: CharacteristicGetCallback) {
    if (this.targetState == -1) {
      this.targetState = convertTCArmStateToHK(await this.tc.getFullStatus());
    }
    this.log.info("Get Characteristic TargetState ->", this.targetState);
    callback(null, this.targetState);
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Brightness
   */
  async setTargetState(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    try {
      this.targetState = value as HKArmState;
      this.log.info("Set Characteristic TargetState -> ", value);

      const newState = await this.tc.armSystem(this.targetState);
      const newTarget = convertTCArmStateToHK(newState);
      this.log.info(`Set target state done [${newState}][${newTarget}]`);

      if (this.targetState != newTarget) {
        this.pollInterval = setInterval(async () => {
          let newState = await this.tc.getFullStatus();
          this.log.info(`POLLING state and got ${newState}`);
          if (newState !== TCArmState.unknown && this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = undefined;
            this.securityService.updateCharacteristic(
              this.api.hap.Characteristic.SecuritySystemCurrentState,
              convertTCArmStateToHK(newState)
            );
          }
        }, 1000);
      }

      callback(null, this.targetState);
    } catch (err) {
      callback(err);
    }
  }
}
