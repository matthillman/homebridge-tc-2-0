import { default as got, Got } from 'got';
import { Logging } from 'homebridge';
import { URLSearchParams } from 'url';
import { xml2js } from 'xml-js';

function convertXML(body) {
    try {
        return xml2js(body, {compact: true, trim: true, nativeType: false, ignoreDoctype: true});
    } catch (error) {
        console.error(`Error converting XML`, body, error.message);
    }

    return null;
}

export class TCError extends Error {
    constructor(result: TCResultCode) {
        let message = '';

        switch (result) {
            case TCResultCode.timeout:
                message = 'Timed out connecting to the system';
                break;
            case TCResultCode.communicationFailure:
                message = 'There was an error communicating with the system';
                break;
            case TCResultCode.invalidLocation:
                message = 'Invalid location supplied';
                break;
            case TCResultCode.connectionError:
                message = 'A connection error occurred';
                break;

            default:
                message = 'An error occurred';
                break;
        }

        super(message);

        // restore prototype chain
        const actualProto = new.target.prototype;

        if (Object.setPrototypeOf) { Object.setPrototypeOf(this, actualProto); }
        else { (this as any).__proto__ = actualProto; }
    }
}

export enum TCResultCode {
    success = '0',
    initiated = '4500',
    expired = '-102',
    timeout = '4101',
    communicationFailure = '4108',
    invalidLocation = '-4002',
    connectionError = '-4008',
}

export enum TCArmState {
    unknown = 0,
    disarmed = 10200,
    armedAway = 10201,
    armedStay = 10203,
    armedNight = 10209,
    fault = 10213
}

export enum HKArmState {
    STAY_ARM = 0,
    AWAY_ARM = 1,
    NIGHT_ARM = 2,
    DISARM = 3,
    ALARM_TRIGGERED = 4,
}

export function convertTCArmStateToHK(state: TCArmState): HKArmState {
    switch (state) {
        case TCArmState.disarmed: return HKArmState.DISARM;
        case TCArmState.armedAway: return HKArmState.AWAY_ARM;
        case TCArmState.armedStay: return HKArmState.STAY_ARM;
        case TCArmState.armedNight: return HKArmState.NIGHT_ARM;
        case TCArmState.fault: return HKArmState.ALARM_TRIGGERED;
        default: return 0;
    }
}

function convertHKArmStateToTC(state: HKArmState): TCArmTarget {
    switch (state) {
        case HKArmState.DISARM: return TCArmTarget.DISARM;
        case HKArmState.AWAY_ARM: return TCArmTarget.AWAY_ARM;
        case HKArmState.STAY_ARM: return TCArmTarget.STAY_ARM;
        case HKArmState.NIGHT_ARM: return TCArmTarget.NIGHT_ARM;
        default: return 0;
    }
}

export enum TCArmTarget {
    DISARM = 0,
    STAY_ARM = 1,
    NIGHT_ARM = 2,
    AWAY_ARM = 3,
}

interface TextNode {
    _text: string;
}

interface ResultDict {
    ResultCode: TextNode,
    ResultData: TextNode,
    SessionID: TextNode
}

interface SessionResponse {
    [key: string]: ResultDict;
}

function isInvalidSessionResponse(object: any): object is SessionResponse {
    const firstValue = (Object.values<any>(object).find(o => 'ResultCode' in o) ?? {});
    // this.log.log(`checking`, firstValue, 'ResultCode' in firstValue, firstValue.ResultCode?._text === TCResultCode.expired)
    return 'ResultCode' in firstValue && firstValue.ResultCode._text === TCResultCode.expired;
}

export interface TCConfig {
    username: string;
    password: string;
};

export class TCApi {
    private static URL_BASE = `https://rs.alarmnet.com/TC21api/tc2.asmx`;
    private API: Got;
    private SessionID = '-1';
    private ApplicationID = '14588';
    private ApplicationVersion = '1.0.0';

    private locationID = '';
    private deviceID = '';

    private log: Logging;
    private config: TCConfig;

    constructor(log: Logging, config: TCConfig) {
        this.log = log;
        this.config = config;
        this.API = got.extend({
            prefixUrl: TCApi.URL_BASE,
            method: 'POST',
            hooks: {
                beforeRequest: [
                    options => {
                        const neededValues = {
                            SessionID: this.SessionID,
                            ApplicationID: this.ApplicationID,
                            ApplicationVersion: this.ApplicationVersion,
                        };

                        const newForm = { ...(options.form ?? {}), ...neededValues };
                        options.form = undefined;
                        options.body = (new URLSearchParams(newForm as Record<string, string>)).toString();
                        options.headers['content-length'] = options.body.length.toString();
                        this.log.debug(`beforeRequest to ${options.url}`);
                    }
                ],
                afterResponse: [
                    async (response, retryWithMergeOptions) => {
                        const jsonResponse = convertXML(response.body);
                        if (isInvalidSessionResponse(jsonResponse)) {
                            await this.getSessionID();
                            return retryWithMergeOptions({});
                        }

                        return response;
                    }
                ]
            },
            mutableDefaults: true,
            form: {}
        });
    }

    async getSessionID() {
        let response;
        try {
            response = await got.post(`AuthenticateUserLogin`, {
                prefixUrl: TCApi.URL_BASE,
                form: {
                    ...this.config,
                    ApplicationID: this.ApplicationID,
                    ApplicationVersion: this.ApplicationVersion,
                }
            });
        } catch (err) {
            this.log.error(`[getSessionID] ${err}`);
            return false
        }

        const jsonResponse = convertXML(response.body) as SessionResponse;
        this.log.debug(`got session response`, jsonResponse);
        if (jsonResponse?.AuthenticateLoginResults?.ResultCode?._text === TCResultCode.success) {
            this.SessionID = jsonResponse.AuthenticateLoginResults.SessionID._text;
            this.log.debug(`using new session id ${this.SessionID}`);
            return true;
        }
        return false;
    }

    async getStatus() {
        let response;
        try {
            response = await this.API(`GetSessionDetails`);
        } catch (err) {
            this.log.error(`[getStatus] ${err}`);
            return false
        }

        const jsonResponse = convertXML(response.body) as any;

        if (![TCResultCode.success || TCResultCode.initiated].includes(jsonResponse.SessionDetailResults.ResultCode._text)) {
            return false;
        }

        let locations = jsonResponse?.SessionDetailResults.Locations ?? [];
        if (!Array.isArray(locations)) {
            locations = [locations];
        }

        const locationInfo = locations[0]?.LocationInfoBasic;
        if (locationInfo) {
            this.locationID = locationInfo.LocationID._text;
            this.deviceID = locationInfo.SecurityDeviceID._text;

            return true;
        } else {
            return false;
        }
    }

    async getFullStatus() {
        if (!this.deviceID) {
            await this.getStatus();
        }

        let response;
        try {
            response = await this.API(`GetPanelMetaDataAndFullStatusByDeviceID`, {
                form: {
                    DeviceID: this.deviceID,
                    LastSequenceNumber: 0,
                    LastUpdatedTimestampTicks: 0,
                    PartitionID: 1
                }
            });
        } catch (err) {
            this.log.error(`[getFullStatus] ${err}`);
            return TCArmState.unknown
        }

        const jsonResponse = convertXML(response.body) as any;

        const resultCode = jsonResponse.PanelMetadataAndStatusResults.ResultCode._text as TCResultCode;
        if (![TCResultCode.success || TCResultCode.initiated].includes(resultCode)) {
            throw new TCError(resultCode);
        }

        let partitions = jsonResponse.PanelMetadataAndStatusResults.PanelMetadataAndStatus.Partitions;

        if (!Array.isArray(partitions)) {
            partitions = [partitions];
        }

        this.log.info(`[ARM STATE] ${partitions[0].PartitionInfo.ArmingState._text}`);
        return parseInt(partitions[0].PartitionInfo.ArmingState._text) as TCArmState;

    }

    async armSystem(state: HKArmState, wait: boolean = false) {
        if (!this.deviceID) {
            await this.getStatus();
        }

        let response;
        try {
            response = await (async () => {
                if (state === HKArmState.DISARM) {
                    return await this.API(`DisarmSecuritySystem`, {
                        form: {
                            DeviceID: this.deviceID,
                            LocationID: this.locationID,
                            UserCode: '-1',
                        }
                    });
                } else {
                    return await this.API(`ArmSecuritySystem`, {
                        form: {
                            DeviceID: this.deviceID,
                            LocationID: this.locationID,
                            UserCode: '-1',
                            ArmType: convertHKArmStateToTC(state),
                        }
                    });
                }
            })();
        } catch (err) {
            this.log.error(`[armSystem] ${err}`);
            return TCArmState.unknown;
        }

        const jsonResponse = convertXML(response.body) as any;

        this.log.debug(jsonResponse);

        const key = state === HKArmState.DISARM ? 'DisarmSecuritySystemResults' : 'ArmSecuritySystemResults'

        const resultCode = jsonResponse[key].ResultCode._text as TCResultCode;
        if (![TCResultCode.success || TCResultCode.initiated].includes(resultCode)) {
            throw new TCError(resultCode);
        }

        if (!wait) {
            return TCArmState.unknown;
        }

        let newState: TCArmState = TCArmState.unknown;
        do {
            newState = await this.getFullStatus();
            this.log.info(`POLLING state and got ${newState}`);
        } while (newState == TCArmState.unknown);

        return newState;

    }

}