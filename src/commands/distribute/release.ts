import {
  AppCommand,
  CommandResult,
  ErrorCodes,
  failure,
  hasArg,
  help,
  longName,
  required,
  shortName,
  success,
} from "../../util/commandline";
import { AppCenterClient, models, clientRequest, ClientResponse } from "../../util/apis";
import { out } from "../../util/interaction";
import { inspect } from "util";
import * as _ from "lodash";
import * as Path from "path";
import * as Pfs from "../../util/misc/promisfied-fs";
import { DefaultApp, getUser, getPortalUrlForEndpoint } from "../../util/profile";
import { getPortalUploadLink, getPortalPatchUploadLink } from "../../util/portal/portal-helper";
import { getDistributionGroup, addGroupToRelease } from "./lib/distribute-util";
import * as fs from "fs";
import { McFusUploader } from "./lib/mc-fus-uploader/mc-fus-uploader";
import { McFusFile, IWorker, McFusMessageLevel, McFusUploadState } from "./lib/mc-fus-uploader/mc-fus-uploader-types";
import * as uuid from "uuid";
import { Worker } from "worker_threads";
import "abort-controller/polyfill";

const fetch = require("node-fetch");

if (!globalThis.fetch) {
  globalThis.fetch = fetch;
}

export class WorkerNode extends Worker implements IWorker {
  Domain: string = "";
  set onmessage(value: (ev: MessageEvent) => any) {
    super.addListener("message", value);
  }
  set onerror(value: () => any) {
    super.addListener("error", value);
  }
  sendChunk(chunk: any, chunkNumber: number, url: string, correlationId: string): void {}
  postMessage(message: any): void {
    super.postMessage(message);
  }
  terminate(): void {
    super.terminate();
  }
}

export class File implements McFusFile {
  readonly name: string;

  public constructor(name: string) {
    this.name = name;
  }

  get size(): number {
    const stats = fs.statSync(this.name);
    return stats["size"];
  }

  slice(start: number, end: number): Buffer {
    const data = Buffer.alloc(end - start);
    const fd = fs.openSync(this.name, "r");
    fs.readSync(fd, data, 0, data.length, start);
    return data;
  }
}

const debug = require("debug")("appcenter-cli:commands:distribute:release");

const globalAsAny = global as any;
globalAsAny.window = {};
(URL as any).createObjectURL = () => {};

// For the following two dependencies, we might want to move it to tests if we want to cover isBrowserSupported
globalAsAny.window.File = File;

globalAsAny.Worker = WorkerNode;

@help("Upload release binary and trigger distribution, at least one of --store or --group must be specified")
export default class ReleaseBinaryCommand extends AppCommand {
  @help("Path to binary file")
  @shortName("f")
  @longName("file")
  @required
  @hasArg
  public filePath: string;

  @help("Build version parameter required for .zip, .msi, .pkg and .dmg files")
  @shortName("b")
  @longName("build-version")
  @hasArg
  public buildVersion: string;

  @help("Build number parameter required for macOS .pkg and .dmg files")
  @shortName("n")
  @longName("build-number")
  @hasArg
  public buildNumber: string;

  @help("Distribution group name")
  @shortName("g")
  @longName("group")
  @hasArg
  public distributionGroup: string;

  @help("Store name")
  @shortName("s")
  @longName("store")
  @hasArg
  public storeName: string;

  @help("Release notes text")
  @shortName("r")
  @longName("release-notes")
  @hasArg
  public releaseNotes: string;

  @help("Path to release notes file")
  @shortName("R")
  @longName("release-notes-file")
  @hasArg
  public releaseNotesFile: string;

  @help("Do not notify testers of this release")
  @longName("silent")
  public silent: boolean;

  @help("Make the release mandatory for the testers (default is false)")
  @longName("mandatory")
  public mandatory: boolean;

  private mcFusUploader?: any;

  public async run(client: AppCenterClient): Promise<CommandResult> {
    const app: DefaultApp = this.app;

    this.validateParameters();

    debug("Loading prerequisites");
    const [distributionGroupUsersCount, storeInformation, releaseBinaryFileStats, releaseNotesString] = await out.progress(
      "Loading prerequisites...",
      this.getPrerequisites(client)
    );

    this.validateParametersWithPrerequisites(storeInformation);
    const createdReleaseUpload = await this.createReleaseUpload(client, app);
    const releaseId = await this.uploadFile(createdReleaseUpload, client, app);
    await this.uploadReleaseNotes(releaseNotesString, client, app, releaseId);
    await this.distributeToGroup(client, app, releaseId);
    await this.distributeToStore(storeInformation, client, app, releaseId);
    await this.checkReleaseOnThePortal(distributionGroupUsersCount, client, app, releaseId);
    return success();
  }

  private async uploadFile(releaseUploadParams: any, client: AppCenterClient, app: DefaultApp): Promise<any> {
    const uploadId = releaseUploadParams.id;
    const assetId = releaseUploadParams.package_asset_id;
    const urlEncodedToken = releaseUploadParams.url_encoded_token;
    const uploadDomain = releaseUploadParams.upload_domain;

    try {
      await this.uploadFileToUri(assetId, urlEncodedToken, uploadDomain);
      await this.patchUpload(app, uploadId);
      return await this.loadReleaseIdUntilSuccess(app, uploadId);
    } catch (error) {
      try {
        out.text("Release upload failed");
        await this.abortReleaseUpload(client, app, uploadId);
        out.text("Release upload was aborted");
      } catch (abortError) {
        debug("Failed to abort release upload");
      }

      throw error;
    }
  }

  private async uploadReleaseNotes(
    releaseNotesString: string,
    client: AppCenterClient,
    app: DefaultApp,
    releaseId: number
  ): Promise<void> {
    if (releaseNotesString && releaseNotesString.length > 0) {
      debug("Setting release notes");
      await this.putReleaseDetails(client, app, releaseId, releaseNotesString);
    } else {
      debug("Skipping empty release notes");
    }
  }

  private async distributeToGroup(client: AppCenterClient, app: DefaultApp, releaseId: number) {
    if (!_.isNil(this.distributionGroup)) {
      debug("Distributing the release to a group");
      const distributionGroupResponse = await getDistributionGroup({
        client,
        releaseId,
        app: this.app,
        destination: this.distributionGroup,
        destinationType: "group",
      });
      await addGroupToRelease({
        client,
        releaseId,
        distributionGroup: distributionGroupResponse,
        app: this.app,
        destination: this.distributionGroup,
        destinationType: "group",
        mandatory: this.mandatory,
        silent: this.silent,
      });
    }
  }

  private async distributeToStore(
    storeInformation: models.ExternalStoreResponse,
    client: AppCenterClient,
    app: DefaultApp,
    releaseId: number
  ) {
    if (!_.isNil(storeInformation)) {
      debug("Distributing the release to a store");
      try {
        await this.publishToStore(client, app, storeInformation, releaseId);
      } catch (error) {
        if (!_.isNil(this.distributionGroup)) {
          out.text(
            `Release was successfully distributed to group '${this.distributionGroup}' but could not be published to store '${this.storeName}'.`
          );
        }
        throw error;
      }
    }
  }

  private async checkReleaseOnThePortal(
    distributionGroupUsersCount: any,
    client: AppCenterClient,
    app: DefaultApp,
    releaseId: number
  ) {
    debug("Retrieving the release");
    const releaseDetails = await this.getDistributeRelease(client, app, releaseId);

    if (releaseDetails) {
      if (!_.isNil(this.distributionGroup)) {
        const storeComment = !_.isNil(this.storeName) ? ` and to store '${this.storeName}'` : "";
        if (_.isNull(distributionGroupUsersCount)) {
          out.text(
            (rd) => `Release ${rd.shortVersion} (${rd.version}) was successfully released to ${this.distributionGroup}${storeComment}`,
            releaseDetails
          );
        } else {
          out.text(
            (rd) =>
              `Release ${rd.shortVersion} (${rd.version}) was successfully released to ${distributionGroupUsersCount} testers in ${this.distributionGroup}${storeComment}`,
            releaseDetails
          );
        }
      } else {
        out.text(
          (rd) => `Release ${rd.shortVersion} (${rd.version}) was successfully released to store '${this.storeName}'`,
          releaseDetails
        );
      }
    } else {
      out.text(`Release was successfully released.`);
    }
  }

  private validateParameters(): void {
    debug("Checking for invalid parameter combinations");
    if (!_.isNil(this.releaseNotes) && !_.isNil(this.releaseNotesFile)) {
      throw failure(ErrorCodes.InvalidParameter, "'--release-notes' and '--release-notes-file' switches are mutually exclusive");
    }
    if (_.isNil(this.distributionGroup) && _.isNil(this.storeName)) {
      throw failure(ErrorCodes.InvalidParameter, "At least one of '--group' or '--store' must be specified");
    }
    if (!_.isNil(this.distributionGroup)) {
      if ([".aab"].includes(this.fileExtension)) {
        throw failure(ErrorCodes.InvalidParameter, `Files of type '${this.fileExtension}' can not be distributed to groups`);
      }
    }
    if (!_.isNil(this.storeName)) {
      if (![".aab", ".apk", ".ipa"].includes(this.fileExtension)) {
        throw failure(ErrorCodes.InvalidParameter, `Files of type '${this.fileExtension}' can not be distributed to stores`);
      }
    }
    if (_.isNil(this.buildVersion)) {
      if ([".zip", ".msi"].includes(this.fileExtension)) {
        throw failure(
          ErrorCodes.InvalidParameter,
          `--build-version parameter must be specified when uploading ${this.fileExtension} files`
        );
      }
    }
    if (_.isNil(this.buildNumber) || _.isNil(this.buildVersion)) {
      if ([".pkg", ".dmg"].includes(this.fileExtension)) {
        throw failure(
          ErrorCodes.InvalidParameter,
          `--build-version and --build-number must both be specified when uploading ${this.fileExtension} files`
        );
      }
    }
  }

  private validateParametersWithPrerequisites(storeInformation: models.ExternalStoreResponse): void {
    debug("Checking for invalid parameter combinations with prerequisites");
    if (storeInformation && storeInformation.type === "apple" && _.isNil(this.releaseNotes) && _.isNil(this.releaseNotesFile)) {
      throw failure(
        ErrorCodes.InvalidParameter,
        "At least one of '--release-notes' or '--release-notes-file' must be specified when publishing to an Apple store."
      );
    }
  }

  private async getPrerequisites(
    client: AppCenterClient
  ): Promise<[number | null, models.ExternalStoreResponse | null, fs.Stats, string]> {
    // load release binary file
    const fileStats = await this.getReleaseFileStream();

    // load release notes file or use provided release notes if none was specified
    const releaseNotesString = this.getReleaseNotesString();

    let distributionGroupUsersNumber: Promise<number | null>;
    let storeInformation: Promise<models.ExternalStoreResponse | null>;
    if (!_.isNil(this.distributionGroup)) {
      // get number of distribution group users (and check distribution group existence)
      // return null if request has failed because of any reason except non-existing group name.
      distributionGroupUsersNumber = this.getDistributionGroupUsersNumber(client);
    }
    if (!_.isNil(this.storeName)) {
      // get distribution store type to check existence and further filtering
      storeInformation = this.getStoreDetails(client);
    }

    return Promise.all([distributionGroupUsersNumber, storeInformation, fileStats, releaseNotesString]);
  }

  private async getReleaseFileStream(): Promise<fs.Stats> {
    try {
      const fileStats = await Pfs.stat(this.filePath);
      return fileStats;
    } catch (error) {
      if (error.code === "ENOENT") {
        throw failure(ErrorCodes.InvalidParameter, `binary file '${this.filePath}' doesn't exist`);
      } else {
        throw error;
      }
    }
  }

  private async getReleaseNotesString(): Promise<string> {
    if (!_.isNil(this.releaseNotesFile)) {
      try {
        return await Pfs.readFile(this.releaseNotesFile, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") {
          throw failure(ErrorCodes.InvalidParameter, `release notes file '${this.releaseNotesFile}' doesn't exist`);
        } else {
          throw error;
        }
      }
    } else {
      return this.releaseNotes;
    }
  }

  private async getDistributionGroupUsersNumber(client: AppCenterClient): Promise<number | null> {
    let distributionGroupUsersRequestResponse: ClientResponse<models.DistributionGroupUserGetResponse[]>;
    try {
      distributionGroupUsersRequestResponse = await clientRequest<models.DistributionGroupUserGetResponse[]>((cb) =>
        client.distributionGroups.listUsers(this.app.ownerName, this.app.appName, this.distributionGroup, cb)
      );
      const statusCode = distributionGroupUsersRequestResponse.response.statusCode;
      if (statusCode >= 400) {
        throw statusCode;
      }
    } catch (error) {
      if (error === 404) {
        throw failure(ErrorCodes.InvalidParameter, `distribution group ${this.distributionGroup} was not found`);
      } else {
        debug(`Failed to get users of distribution group ${this.distributionGroup}, returning null - ${inspect(error)}`);
        return null;
      }
    }

    return distributionGroupUsersRequestResponse.result.length;
  }

  private async getStoreDetails(client: AppCenterClient): Promise<models.ExternalStoreResponse | null> {
    try {
      const storeDetailsResponse = await clientRequest<models.ExternalStoreResponse>((cb) =>
        client.stores.get(this.storeName, this.app.ownerName, this.app.appName, cb)
      );
      const statusCode = storeDetailsResponse.response.statusCode;
      if (statusCode >= 400) {
        throw { statusCode };
      }
      return storeDetailsResponse.result;
    } catch (error) {
      if (error.statusCode === 404) {
        throw failure(ErrorCodes.InvalidParameter, `store '${this.storeName}' was not found`);
      } else {
        debug(`Failed to get store details for '${this.storeName}', returning null - ${inspect(error)}`);
        return null;
      }
    }
  }

  private async createReleaseUpload(client: AppCenterClient, app: DefaultApp): Promise<any> {
    debug("Creating release upload");
    const profile = getUser();
    const url = getPortalUploadLink(getPortalUrlForEndpoint(profile.endpoint), app.ownerName, app.appName);
    const accessToken = await profile.accessToken;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": accessToken,
      },
      body: "{}",
    });
    const json = await response.json();
    if (!json.package_asset_id || (json.statusCode && json.statusCode !== 200)) {
      throw failure(ErrorCodes.Exception, `failed to create release upload for ${this.filePath}. ${json.message}`);
    }
    return json;
  }

  private uploadFileToUri(assetId: string, urlEncodedToken: string, uploadDomain: string): Promise<any> {
    return new Promise((resolve, reject) => {
      debug("Uploading the release binary");
      const uploadSettings: any = {
        AssetId: assetId,
        UrlEncodedToken: urlEncodedToken,
        UploadDomain: uploadDomain,
        Tenant: "distribution",
        onProgressChanged: (progress: any) => {
          //todo nice to have updated progress log
          debug("onProgressChanged: " + progress.percentCompleted);
        },
        onMessage: (message: string, properties: any, level: any) => {
          debug(`onMessage: ${message} \nMessage properties: ${JSON.stringify(properties)}`);
          if (level === McFusMessageLevel.Error) {
            this.mcFusUploader.Cancel();
            reject();
          }
        },
        onStateChanged: (status: McFusUploadState): void => {
          //todo get state title
          debug(`onStateChanged: ${status}`);
        },
        onCompleted: (uploadStats: any) => {
          debug("Upload completed, total time: " + uploadStats.TotalTimeInSeconds);
          resolve();
        },
      };
      this.mcFusUploader = new McFusUploader(uploadSettings);
      const worker = new WorkerNode(__dirname + "/release-worker.js");
      this.mcFusUploader.setWorker(worker);
      const testFile = new File(this.filePath);
      this.mcFusUploader.Start(testFile);
    });
  }

  private async patchUpload(app: DefaultApp, uploadId: string): Promise<void> {
    debug("Patching the upload");
    const profile = getUser();
    const url = getPortalPatchUploadLink(getPortalUrlForEndpoint(profile.endpoint), app.ownerName, app.appName, uploadId);
    const accessToken = await profile.accessToken;
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": accessToken,
      },
      body: '{"upload_status":"uploadFinished"}',
    });
    const json = await response.json();
    if (json.upload_status !== "uploadFinished") {
      throw failure(ErrorCodes.Exception, `failed to patch release upload ${json}`);
    }
  }

  private async loadReleaseIdUntilSuccess(app: DefaultApp, uploadId: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const timerId = setInterval(async () => {
        const response = await this.loadReleaseId(app, uploadId);
        const releaseId = response.release_distinct_id;
        debug(`Received release id is ${releaseId}`);
        if (response.upload_status === "readyToBePublished" && releaseId) {
          clearInterval(timerId);
          resolve(Number(releaseId));
        } else if (response.upload_status === "error") {
          clearInterval(timerId);
          debug(`Loading release id failed: ${response.error_details}`);
          reject();
        }
      }, 2000);
    });
  }

  private async loadReleaseId(app: DefaultApp, uploadId: string): Promise<any> {
    try {
      debug("Loading release id...");
      const profile = getUser();
      const url = getPortalPatchUploadLink(getPortalUrlForEndpoint(profile.endpoint), app.ownerName, app.appName, uploadId);
      const accessToken = await profile.accessToken;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-api-token": accessToken,
        },
      });
      return await response.json();
    } catch (error) {
      throw failure(ErrorCodes.Exception, `failed to get release id for upload id: ${uploadId}, error: ${JSON.stringify(error)}`);
    }
  }

  private async abortReleaseUpload(client: AppCenterClient, app: DefaultApp, uploadId: string): Promise<void> {
    let abortReleaseUploadRequestResponse: ClientResponse<models.ReleaseUploadEndResponse>;
    try {
      abortReleaseUploadRequestResponse = await out.progress(
        "Aborting release upload...",
        clientRequest<models.ReleaseUploadEndResponse>((cb) =>
          client.releaseUploads.complete(uploadId, app.ownerName, app.appName, "aborted", cb)
        )
      );
    } catch (error) {
      throw new Error(
        `HTTP ${abortReleaseUploadRequestResponse.response.statusCode} - ${abortReleaseUploadRequestResponse.response.statusMessage}`
      );
    }
  }

  private extractReleaseId(releaseUrl: string): number {
    const releaseId = Number(_(releaseUrl).split("/").last());
    console.assert(Number.isSafeInteger(releaseId) && releaseId > 0, `API returned unexpected release URL: ${releaseUrl}`);
    return releaseId;
  }

  private async getDistributeRelease(
    client: AppCenterClient,
    app: DefaultApp,
    releaseId: number
  ): Promise<models.ReleaseDetailsResponse> {
    let releaseRequestResponse: ClientResponse<models.ReleaseDetailsResponse>;
    try {
      releaseRequestResponse = await out.progress(
        `Retrieving the release...`,
        clientRequest<models.ReleaseDetailsResponse>(async (cb) =>
          client.releasesOperations.getLatestByUser(releaseId.toString(), app.ownerName, app.appName, cb)
        )
      );
    } catch (error) {
      if (error === 400) {
        throw failure(ErrorCodes.Exception, "release_id is not an integer or the string latest");
      } else if (error === 404) {
        throw failure(ErrorCodes.Exception, `The release ${releaseId} can't be found`);
      } else {
        return null;
      }
    }

    return releaseRequestResponse.result;
  }

  private async putReleaseDetails(
    client: AppCenterClient,
    app: DefaultApp,
    releaseId: number,
    releaseNotesString?: string
  ): Promise<models.ReleaseUpdateResponse> {
    try {
      const { result, response } = await out.progress(
        `Updating release details...`,
        clientRequest<models.ReleaseUpdateResponse>(async (cb) =>
          client.releasesOperations.updateDetails(
            releaseId,
            app.ownerName,
            app.appName,
            {
              releaseNotes: releaseNotesString,
            },
            cb
          )
        )
      );

      const statusCode = response.statusCode;
      if (statusCode >= 400) {
        debug(`Got error response: ${inspect(response)}`);
        throw statusCode;
      }
      return result;
    } catch (error) {
      if (error === 400) {
        throw failure(ErrorCodes.Exception, "failed to set the release notes");
      } else {
        debug(`Failed to distribute the release - ${inspect(error)}`);
        throw failure(ErrorCodes.Exception, `failed to set release notes for release ${releaseId}`);
      }
    }
  }

  private async publishToStore(
    client: AppCenterClient,
    app: DefaultApp,
    storeInformation: models.ExternalStoreResponse,
    releaseId: number
  ): Promise<void> {
    try {
      const { result, response } = await out.progress(
        `Publishing to store '${storeInformation.name}'...`,
        clientRequest<void>(async (cb) =>
          client.releasesOperations.addStore(releaseId, app.ownerName, app.appName, storeInformation.id, cb)
        )
      );

      const statusCode = response.statusCode;
      if (statusCode >= 400) {
        throw result;
      }
      return result;
    } catch (error) {
      debug(`Failed to distribute the release to store - ${inspect(error)}`);
      throw failure(ErrorCodes.Exception, error.message);
    }
  }

  private get fileExtension(): string {
    return Path.parse(this.filePath).ext.toLowerCase();
  }
}
