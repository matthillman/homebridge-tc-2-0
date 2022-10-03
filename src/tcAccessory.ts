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
import { HKArmState, TCApi, TCArmState } from "./tc.v2";

export class TotalConnectAccessory implements AccessoryPlugin {
  private readonly log: Logging;
  private readonly api: API;
  private readonly name: string;

  private readonly securityService: Service;
  private readonly informationService: Service;

  private tc: TCApi;

  private targetState: CharacteristicValue = -1;
  private currentState: CharacteristicValue = -1;

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
      let newState = await this.tc.getStatus();
      this.log.info(`AUTO-POLLING state and got ${newState}`);
      const converted = this.tc.convertTCArmStateToHK(newState);
      if (newState !== TCArmState.unknown && this.currentState !== converted) {
        this.currentState = converted;
        this.securityService.updateCharacteristic(
          this.api.hap.Characteristic.SecuritySystemCurrentState,
          this.currentState
        );
      }
    }, 1000 * 60 * 3.5);

    this.log.debug(`TC Accessory init complete`);
  }

  getServices(): Service[] {
    return [this.informationService, this.securityService];
  }

  async getCurrentState(callback: CharacteristicSetCallback) {
    try {
      if (this.currentState == -1) {
        this.currentState = this.tc.convertTCArmStateToHK(await this.tc.getStatus());
      }

      this.log.info("Get current state ->", this.currentState);

      callback(null, this.currentState);
    } catch (err) {
      callback(err as any);
    }
  }

  async getTargetState(callback: CharacteristicGetCallback) {
    if (this.targetState == -1) {
      this.targetState = this.tc.convertTCArmStateToHK(await this.tc.getStatus());
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
      const newTargetState = value as HKArmState;
      this.log.info("Set Characteristic TargetState -> ", this.targetState, newTargetState);

      if (this.targetState === newTargetState) {
        callback(null);
        return;
      }

      this.targetState = newTargetState;
      const newState = await this.tc.armSystem(this.targetState);
      this.log.info(`Set target state done [${newState}]`);

      if (newState) {
        this.securityService.updateCharacteristic(
          this.api.hap.Characteristic.SecuritySystemCurrentState,
          newTargetState
        );
      }

      callback(null);
    } catch (err) {
      callback(err as any);
    }
  }
}
