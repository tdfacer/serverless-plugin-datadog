import {
  updateMonitor,
  createMonitor,
  deleteMonitor,
  getExistingMonitors,
  getRecommendedMonitors,
  TemplateVariable,
} from "./monitor-api-requests";
import { Response } from "node-fetch";

export interface MonitorParams {
  [key: string]: any;
}
export interface Monitor {
  [key: string]: MonitorParams;
}

interface ApiErrorResponse {
  errors: string[] | Record<string, unknown>;
}

interface ApiSuccessResponse {
  [key: string]: any;
}

type ApiResponse = ApiErrorResponse | ApiSuccessResponse;

export interface ServerlessMonitor {
  name: string;
  threshold: number;
  query: (cloudFormationStackId: string, criticalThreshold: number) => string;
  message: string;
  type?: string;
  templateVariables?: TemplateVariable[];
}

export interface RecommendedMonitors {
  [key: string]: ServerlessMonitor;
}

export function isApiErrorResponse(response: ApiResponse): response is ApiErrorResponse {
  return "errors" in response;
}

export function formatErrorDetails(errors: ApiErrorResponse["errors"]): string {
  if (Array.isArray(errors)) {
    return errors.join(", ");
  }

  if (typeof errors === "object" && errors !== null) {
    return Object.entries(errors)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(", ");
  }

  return "No error details available";
}

/**
 * Adds the appropriate tags and required parameters that will be passed as part of the request body for creating and updating monitors
 * @param monitor - the Monitor object that is defined in the serverless.yml file
 * @param cloudFormationStackId - the Cloud Formation Stack ID
 * @param service - the Service
 * @param env  - the Environment
 * @param recommendedMonitors  - recommended monitors
 * @returns valid monitor parameters
 */
export function buildMonitorParams(
  monitor: Monitor,
  cloudFormationStackId: string,
  service: string,
  env: string,
  recommendedMonitors: RecommendedMonitors,
): { [x: string]: any } {
  const serverlessMonitorId = Object.keys(monitor)[0];

  if (!monitor[serverlessMonitorId]) {
    monitor[serverlessMonitorId] = {};
  }

  const monitorParams = { ...monitor[serverlessMonitorId] };

  if (!monitorParams.tags) {
    monitorParams.tags = [];
  }
  if (!monitorParams.options) {
    monitorParams.options = {};
  }
  if (monitorParams.type === undefined) {
    monitorParams.type = "metric alert";
  }

  monitorParams.tags = [
    ...monitorParams.tags,
    "serverless_monitor_type:single_function",
    `serverless_monitor_id:${serverlessMonitorId}`,
    `aws_cloudformation_stack-id:${cloudFormationStackId}`,
    "created_by:dd_sls_plugin",
    `env:${env}`,
    `service:${service}`,
  ];

  if (isRecommendedMonitor(serverlessMonitorId, recommendedMonitors)) {
    const recommendedMonitor = recommendedMonitors[serverlessMonitorId];
    let criticalThreshold = recommendedMonitor.threshold;

    if (monitorParams.options?.thresholds?.critical !== undefined) {
      criticalThreshold = monitorParams.options.thresholds.critical;
    }

    monitorParams.query = recommendedMonitor.query(cloudFormationStackId, criticalThreshold);

    if (!monitorParams.message) {
      monitorParams.message = recommendedMonitor.message;
    }
    if (!monitorParams.name) {
      monitorParams.name = getInterpolatedMonitorName(recommendedMonitor);
    }
  }

  return monitorParams;
}

/**
 * Checks to see if the given monitor is a serverless recommended monitor
 * @param serverlessMonitorId - Unique ID string defined for each monitor
 * @param recommendedMonitors  - recommended monitors
 * @returns true if a given monitor is a serverless recommended monitor
 */
function isRecommendedMonitor(serverlessMonitorId: string, recommendedMonitors: RecommendedMonitors): boolean {
  return recommendedMonitors[serverlessMonitorId] !== undefined;
}

/**
 * Deletes the monitors that have been removed from the plugin
 * @param site Which Datadog site to send data to, e.g. datadoghq.com
 * @param pluginMonitors Monitors that are currently defined in the plugin
 * @param existingMonitors Monitors that have already been created
 * @param monitorsApiKey API Key
 * @param monitorsAppKey Application Key
 * @returns an array of successfully deleted monitors
 */
async function deleteRemovedMonitors(
  site: string,
  pluginMonitors: Monitor[],
  existingMonitors: { [key: string]: number },
  monitorsApiKey: string,
  monitorsAppKey: string,
): Promise<string[]> {
  const successfullyDeletedMonitors: string[] = [];
  const currentMonitorIds: string[] = [];
  pluginMonitors.forEach((currentMonitor) => currentMonitorIds.push(Object.keys(currentMonitor)[0]));
  for (const pluginMonitorId of Object.keys(existingMonitors)) {
    if (!currentMonitorIds.includes(pluginMonitorId)) {
      const response = await deleteMonitor(site, existingMonitors[pluginMonitorId], monitorsApiKey, monitorsAppKey);
      const successfullyDeleted = await handleMonitorsApiResponse(response, pluginMonitorId);
      if (successfullyDeleted) {
        successfullyDeletedMonitors.push(`${pluginMonitorId}`);
      }
    }
  }
  return successfullyDeletedMonitors;
}

/**
 * Handles the Monitor API response and logs the appropriate error
 * @param response Monitor API Response
 * @param serverlessMonitorId Serverless Monitor ID
 * @param subdomain Subdomain to use for app URLs, e.g. "app"
 * @param site Which Datadog site to send data to, e.g. datadoghq.com
 * @returns true if the response is 200 OK. Throw an error for other HTTP status codes.
 */
export async function handleMonitorsApiResponse(
  response: Response,
  serverlessMonitorId?: string,
  subdomain?: string,
  site?: string,
): Promise<boolean> {
  if (response.status === 200) {
    return true;
  }

  let responseData: ApiResponse;

  try {
    if (typeof response.json === "function") {
      responseData = await response.json();
    } else {
      throw new Error("Response does not support JSON parsing");
    }
  } catch (error) {
    throw new Error(`Unexpected response status: ${response.status} ${response.statusText}`);
  }

  if (response.status === 400) {
    const errorDetails = isApiErrorResponse(responseData)
      ? formatErrorDetails(responseData.errors)
      : "No error details available";

    const errorParts = [
      `400 Bad Request: Incorrect syntax or missing required tag`,
      serverlessMonitorId ? `Monitor ID: ${serverlessMonitorId}` : null,
      `Error Details: ${errorDetails}`,
    ].filter(Boolean);

    if (subdomain && site) {
      errorParts.push(`Check your monitor tag policies: https://${subdomain}.${site}/monitors/settings/policies`);
    }

    throw new Error(errorParts.join(". "));
  }

  throw new Error(`Unexpected response status: ${response.status} ${response.statusText}`);
}

/**
 * Creates, updates, and deletes the appropriate monitor configurations as defined in the serverless.yml file
 * @param subdomain - Subdomain to use for app URLs, e.g. "app"
 * @param site - Which Datadog site to send data to, e.g. datadoghq.com
 * @param monitors - Monitors defined in the serverless.yml file
 * @param monitorsApiKey - the API Key
 * @param monitorsAppKey - the Application Key
 * @param cloudFormationStackId - the Cloud Formation Stack ID
 * @param service - the Service
 * @param env - the Environment
 * @returns Log statements showing the monitors that have been successfully
 *          created, updated, and deleted according to the configuration
 *          defined in the plugin
 */
export async function setMonitors(
  subdomain: string,
  site: string,
  monitors: Monitor[],
  monitorsApiKey: string,
  monitorsAppKey: string,
  cloudFormationStackId: string,
  service: string,
  env: string,
): Promise<string[]> {
  const recommendedMonitors = await getRecommendedMonitors(site, monitorsApiKey, monitorsAppKey);
  const existingMonitors = await getExistingMonitors(site, cloudFormationStackId, monitorsApiKey, monitorsAppKey);

  const successfullyUpdatedMonitors: string[] = [];
  const successfullyCreatedMonitors: string[] = [];
  const failedMonitors: string[] = [];

  for (const monitor of monitors) {
    const serverlessMonitorId = Object.keys(monitor)[0];
    const monitorIdNumber = existingMonitors[serverlessMonitorId];
    const monitorParams = buildMonitorParams(monitor, cloudFormationStackId, service, env, recommendedMonitors);
    const monitorExists = existingMonitors.hasOwnProperty(serverlessMonitorId);

    try {
      let response: Response;

      if (monitorExists) {
        response = await updateMonitor(site, monitorIdNumber, monitorParams, monitorsApiKey, monitorsAppKey);
      } else {
        response = await createMonitor(site, monitorParams, monitorsApiKey, monitorsAppKey);
      }

      const success = await handleMonitorsApiResponse(response, serverlessMonitorId, subdomain, site);
      if (success) {
        if (monitorExists) {
          successfullyUpdatedMonitors.push(`${serverlessMonitorId}`);
        } else {
          successfullyCreatedMonitors.push(`${serverlessMonitorId}`);
        }
      }
    } catch (error) {
      failedMonitors.push(serverlessMonitorId);
    }
  }

  const successfullyDeletedMonitors = await deleteRemovedMonitors(
    site,
    monitors,
    existingMonitors,
    monitorsApiKey,
    monitorsAppKey,
  );

  const logStatements: string[] = [];
  if (successfullyUpdatedMonitors.length > 0) {
    logStatements.push(`Successfully updated ${successfullyUpdatedMonitors.join(", ")}`);
  }
  if (successfullyCreatedMonitors.length > 0) {
    logStatements.push(`Successfully created ${successfullyCreatedMonitors.join(", ")}`);
  }
  if (successfullyDeletedMonitors.length > 0) {
    logStatements.push(`Successfully deleted ${successfullyDeletedMonitors.join(", ")}`);
  }
  if (failedMonitors.length > 0) {
    logStatements.push(`Failed to process ${failedMonitors.join(", ")}`);
  }

  return logStatements;
}

/** Helper function that replaces the default threshold included in the query string with the new critical threshold configured by the customer
 * @param query - the query string
 * @param criticalThreshold = new critical threshold as defined by the customer
 * @returns the query string where the critical threshold is already replaced
 */
export function replaceCriticalThreshold(query: string, criticalThreshold: number): string {
  const thresholdComparison = /(>=|>)(.*)$/;
  const newQuery = query.replace(thresholdComparison, `$1 ${criticalThreshold}`);

  return newQuery;
}

/**
 * Helper function that interpolates template variables (if any) into the name
 * of a recommended monitor, e.g. replaces template variable `$functionName`
 * with its default value `{{functionname.name}}`. The interpolation result is
 * returned. The original monitor params are not altered.
 * Template variables with no default value will be ignored.
 * @param recommendedMonitors  - recommended monitors
 * @returns Interpolation result, e.g. "High Error Rate on {{functionname.name}} in {{region.name}} for {{aws_account.name}}"
 */
function getInterpolatedMonitorName(recommendedMonitor: ServerlessMonitor): string {
  let interpolatedName = recommendedMonitor.name;
  recommendedMonitor.templateVariables?.forEach((templateVariable) => {
    if (templateVariable.defaults.length > 0) {
      interpolatedName = interpolatedName.replace("$" + templateVariable.name, templateVariable.defaults[0]);
    }
  });
  return interpolatedName;
}
