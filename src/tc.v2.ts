
import { default as got, Got, Method, Options, Response } from 'got';
import { Logging } from 'homebridge';
import { resolve } from 'path';
import { report } from 'process';
import { ResourceOwnerPassword } from 'simple-oauth2';
import { xml2js } from 'xml-js';

const oauthConfig = {
    client: {
        id: 'c7f230ff686b4cc284b6c78a40aa255d',
        secret: ''
    },
    auth: {
        tokenHost: `https://rs.alarmnet.com`,
        tokenPath: `/TC2API.Auth/token`
    },
    options: {
        // bodyFormat: 'json',
        authorizationMethod: 'body',
        // json: 'force',
    }
};

export interface TCConfig {
    username: string;
    password: string;
};

export enum TCResultCode {
    success = 0,
    initiated = 4500,
    poll = 4501,
    expired = -102,
    timeout = -4101,
    invalidUserCode = -4106,
    communicationFailure = -4108,
    invalidLocation = -4002,
    connectionError = -4008,
}

export enum TCArmState {
    unknown = 0,
    disarmed = 10200,
    armedAway = 10201,
    armedAwayBypass = 10202,
    armedStay = 10203,
    armedStayBypass = 10204,
    armedAwayInstant = 10205,
    armedAwayInstantBypass = 10206,
    // This code is reported for perimeter sensor devices (doors and windows). It is also reported for manually pushed buttons on the panel Medical and Police.
    perimeterAlarming = 10207,
    armedNight = 10209,
    armedNightBypass = 10210,
    disarmedBypass = 10211,
    // This code is reported for smoke detectors. It is also reported for manually pushed buttons on the panel for Fire.
    alarmingFireSmoke = 10212,
    alarmingCarbonMonoxide = 10213,
    // zone(s) faulted
	disarmedNotReadyToArm = 10214,
	armedStayNight = 10218,
    // Reported by ProA7 panel.
	armedStayNightBypass = 10219,
    // Reported by ProA7 panel.
	armedStayNightInstant = 10220,
    // Reported by ProA7 panel.
	armedStayNightInstantBypass = 10221,
	armedCustomBypass = 10223,
    // Suddenly reported for Lynx Touch 7000 in November 2021, which previously reported as 10203
	armedStayLynxTouch = 10226,
    arming = 10307,
    // Reported by ProA7 panel.
    armedStayProA7 = 10230,
    //  Reported by ProA7 panel.
    armedStayBypassProA7 = 10231,
    //  Reported by ProA7 panel.
    armedStayInstantProA7 = 10232,
    //  Reported by ProA7 panel.
    armedStayInstantBypassProA7 = 10233,
    disarming = 10308,
}

export enum HKArmState {
    STAY_ARM = 0,
    AWAY_ARM = 1,
    NIGHT_ARM = 2,
    DISARM = 3,
    ALARM_TRIGGERED = 4,
}

interface TCPartitionCommentStateChange {
    PartitionId: number;
    Result: number;
}

interface TCCommentStateChange {
    PartitionStateChange: TCPartitionCommentStateChange[];
}

interface TCPollResult {
    ResultCode: TCResultCode;
    ResultData: string;
}

interface TCSecurityCommentStateResult extends TCPollResult {
    StatusChange: TCCommentStateChange[];
}

interface TCDevice {
    id: number;
    name: string;
    deviceClass: string;
    CanSupportArmNightStay: boolean;
    userCodeAvailable: boolean;
}

interface TCLocationDetail {
    id: number;
    name: string;
    PhotoURL: string;
    LocationModuleFlags: string;
    devices: TCDevice[];
    IsLocationToBeDisplayed: boolean;
}

interface TCLocationResult {
    locationDetailResult: TCLocationDetail[];
}

interface TCPartitionDetails {
    PartitionName: string;
    IsStayArmed: boolean;
    IsFireEnabled: boolean;
    IsCommonEnabled: boolean;
    IsLocked: boolean;
    IsNewPartition: boolean;
    IsNightStayEnabled: number;
    ExitDelayTimer: number;
    PartitionID: number;
    ArmingState: number;
    IsAlarmResponded: boolean;
    AlarmTriggerTimeLocalized: Date;
}

interface TCPanelStatusInfo {
    Zones: any[];
    PromptForImportSecuritySettings: boolean;
    IsAlarmResponded: boolean;
    IsCoverTampered: boolean;
    Bell1SupervisionFailure: boolean;
    Bell2SupervisionFailure: boolean;
    SyncSecDeviceFlag: boolean;
    LastUpdatedTimestampTicks : number;
    ConfigurationSequenceNumber	: number;
    IsInACLoss: boolean;
    IsInLowBattery: boolean;
    Partitions: TCPartitionDetails[];
}

interface TCPanelMetadataAndStatusResults {
    PanelStatus: TCPanelStatusInfo;
    ArmingState: TCArmState;
}

interface APIParameters {
    [key: string]: string | number | string[] | number[];
}

export class TCApi {
    private static URL_BASE = `https://rs.alarmnet.com/TC2API.TCResource/api/`;
    private API: Got;

    private locationID: number = 0;
    private deviceID: number = 0;
    private partitions: number[] = [];
    private polling?: Promise<boolean>;


    private log: Logging;

    constructor(log: Logging, config: TCConfig) {
        this.log = log;
        this.API = got.extend({
            prefixUrl: TCApi.URL_BASE,
            method: 'POST',
            headers: {
                authorization: 'Bearer fake'
            },
            responseType: 'json',
            hooks: {
                afterResponse: [
                    async (response, retryWithMergedOptions) => {
                        if (response.statusCode === 401) {
                            const newToken = await this.getToken(config);
                            const updatedOptions: Options = {
                                headers: {
                                    authorization: `${newToken.token.token_type} ${newToken.token.access_token}`
                                }
                            };

                            this.API.defaults.options = got.mergeOptions(this.API.defaults.options, updatedOptions);

                            return retryWithMergedOptions(updatedOptions);
                        }

                        return response;
                    }
                ]
            },
            mutableDefaults: true
        });
    }

    convertTCArmStateToHK(state: TCArmState): HKArmState {
        switch (true) {
            case state == TCArmState.arming ||
                state == TCArmState.disarmed ||
                state == TCArmState.disarmedBypass ||
                state == TCArmState.disarmedNotReadyToArm ||
                state == TCArmState.disarming:
                return HKArmState.DISARM;
            case state == TCArmState.armedAway ||
                state == TCArmState.armedAwayBypass ||
                state == TCArmState.armedAwayInstant ||
                state == TCArmState.armedAwayInstantBypass:
                return HKArmState.AWAY_ARM;
            case state == TCArmState.armedStay ||
                state == TCArmState.armedStayBypass ||
                state == TCArmState.armedCustomBypass ||
                state == TCArmState.armedStayLynxTouch ||
                state == TCArmState.armedStayProA7 ||
                state == TCArmState.armedStayBypassProA7:
                return HKArmState.STAY_ARM;
            case state == TCArmState.armedNight ||
                state == TCArmState.armedNightBypass ||
                state == TCArmState.armedStayNight ||
                state == TCArmState.armedStayNightBypass ||
                state == TCArmState.armedStayNightInstant ||
                state == TCArmState.armedStayNightInstantBypass ||
                state == TCArmState.armedStayInstantProA7 ||
                state == TCArmState.armedStayInstantBypassProA7:
                return HKArmState.NIGHT_ARM;
            case state == TCArmState.alarmingFireSmoke ||
                state == TCArmState.alarmingCarbonMonoxide ||
                state == TCArmState.perimeterAlarming:
                return HKArmState.ALARM_TRIGGERED;
        }

        this.log.error(`Unknown state received: ${state}`);

        return 0;
    }

    async getToken(config: TCConfig) {
        const client = new ResourceOwnerPassword(oauthConfig);

        try {
            return await client.getToken(config, {json: true});
        } catch (error: any) {
            this.log.error(`Error getting access token: ${error.message}`);
        }

        return {token: {}};
    }

    async callApi<T>(endpoint: string = '', v1 = true, method: Method = 'GET', parameters: APIParameters = {}) {
        const paramKey =  method === 'GET' ? 'searchParams' : 'json';
        const end = endpoint.replace(/^\//, '');
        return this.API<T>(`${v1 ? 'v1' : 'v2'}/locations${end.length ? '/' : ''}${end}`, {
            [paramKey]: parameters as any,
            method
        });
    }

    async apiGET<T>(endpoint: string = '', v1 = true) {
        return this.callApi<T>(endpoint, v1, 'GET');
    }
    async apiPUT<T>(endpoint: string = '', parameters: APIParameters, v1 = false) {
        return this.callApi<T>(endpoint, v1, 'PUT', parameters);
    }

    async getLocation() {
        if (this.locationID !== 0) {
             return this.locationID;
        }

        const response = await this.apiGET<TCLocationResult>();

        const locations = response.body;

        const firstLocation = locations.locationDetailResult[0];
        if (firstLocation) {
            this.locationID = firstLocation.id;
            this.deviceID = firstLocation.devices[0].id;
        }

        this.log.info(`[getLocation] got location [${this.locationID}], device [${this.deviceID}]`);

        // Also need to get status once to load partitions
        const currentStatus = await this.getStatus();
        this.log.info(`[getLocation] updated stats [${currentStatus}]`);

        return this.locationID;
    }

    async getStatus() {
        let response: Response<TCPanelMetadataAndStatusResults>;
        try {
            response = await this.apiGET<TCPanelMetadataAndStatusResults>(`${await this.getLocation()}/partitions/fullStatus`);
        } catch (err) {
            this.log.error(`[getStatus] ${err}`);
            return TCArmState.unknown;
        }

        // Retrive the global Arming State as opposed to the first Partition arming state.
        const globalArmingState = response.body.ArmingState;
        this.log.info(`[getStatus] got status [${response.body.ArmingState}] ([${globalArmingState}])`);

        // Partions array isn't returned per the API spec so use the PartitionID from the Zones array instead
        this.partitions = response.body.PanelStatus.Zones.map(p => p.PartitionID);

        return globalArmingState;
    }

    async armSystem(state: HKArmState) {
        const endpoint = state === HKArmState.DISARM ? `disArm` : `arm`;

        this.log.info(`[armSystem] changing system state [${endpoint}]`);

        // Ensure all metadata is loaded
        await this.getLocation();

        const newState = (() => {
            switch (state) {
                case HKArmState.AWAY_ARM: return 0;
                case HKArmState.STAY_ARM: return 1;
                case HKArmState.NIGHT_ARM: return 2;
                case HKArmState.DISARM: return -1;
                default: return -1;
            }
        })()

        const data = {
            armType: newState,
            partitions: this.partitions,
            userCode: -1
        };

        console.log(data);

        const response = await this.apiPUT<TCPollResult>(`${await this.getLocation()}/devices/${this.deviceID}/partitions/${endpoint}`, data);

        this.log.info(`[armSystem] status [${response.body.ResultCode}]`);

        console.log(response.body);

        if (response.body.ResultCode === TCResultCode.initiated || response.body.ResultCode === TCResultCode.success) {
            if (this.polling === undefined) {
                this.polling = new Promise<boolean>((resolve, reject) => {
                    setTimeout(() => this.pollState(resolve, reject), 1000);
                });
            }
            return this.polling;
        }

        return false;
    }

    async pollState(resolve: (value: boolean | PromiseLike<boolean>) => void, reject: (reason?: any) => void) {
        if (!this.polling) {
            this.log.info(`[pollState] polling called but no promise`);
            resolve(true);
            return;
        }

        const response = await this.apiGET<TCSecurityCommentStateResult>(`${await this.getLocation()}/devices/${this.deviceID}/partitions/lastCommandState/-1?PartitionIds=${this.partitions.join(',')}`, true);

        this.log.info(`[pollState] polling returned status [${response.body.ResultCode}]`);

        console.log(response.body);

        if (response.body.ResultCode === TCResultCode.initiated || response.body.ResultCode === TCResultCode.poll) {
            setTimeout(() => this.pollState(resolve, reject), 2000);
            return;
        }

        this.log.info(`[pollState] polling done with status [${response.body.ResultCode}]`);

        resolve(response.body.ResultCode === TCResultCode.success);
        this.polling = undefined;
    }
}
