const { name: packageName, version: packageVersion } = require("../package.json");
const G: any = global || window || {};
const PACKAGE_GUARD: symbol = Symbol.for(packageName);
if (PACKAGE_GUARD in G) {
	const conflictVersion = G[PACKAGE_GUARD];
	// tslint:disable-next-line: max-line-length
	const msg = `Conflict module version. Looks like two different version of package ${packageName} was loaded inside the process: ${conflictVersion} and ${packageVersion}.`;
	if (process !== undefined && process.env !== undefined && process.env.NODE_ALLOW_CONFLICT_MODULES === "1") {
		console.warn(msg + " This treats as warning because NODE_ALLOW_CONFLICT_MODULES is set.");
	} else {
		throw new Error(msg + " Use NODE_ALLOW_CONFLICT_MODULES=\"1\" to treats this error as warning.");
	}
} else {
	G[PACKAGE_GUARD] = packageVersion;
}

import { CancellationToken, Configuration as RawConfiguration } from "@zxteam/contract";
import { ManualCancellationTokenSource, CancellationTokenSource } from "@zxteam/cancellation";
import {
	fileConfiguration, chainConfiguration, envConfiguration,
	secretsDirectoryConfiguration,
	Configuration as KeyValueConfiguration
} from "@zxteam/configuration";
import { CancelledError } from "@zxteam/errors";
import { logger } from "@zxteam/logger";

import { Provided as ProvidedOrig } from "typescript-ioc";

/*
	This module provides a facade for IoC functionality.
	Currently we use https://www.npmjs.com/package/typescript-ioc
		but we may change IoC library in future.
	[!] The application should not import "typescript-ioc" directly
*/
export { AutoWired, Container, Inject, Provides, Singleton } from "typescript-ioc";
export function Provided<T>(provider: Provider<T>): (target: Function) => void {
	return ProvidedOrig(provider);
}
export interface Provider<T> { get(): T; }

export interface Runtime {
	destroy(): Promise<void>;
}

export type RawConfigurationLoader = (cancellationToken: CancellationToken) => Promise<RawConfiguration>;
export type ConfigurationParser<TConfiguration> = (rawConfiguration: RawConfiguration) => TConfiguration;

export type RuntimeFactory<TConfiguration> = (cancellationToken: CancellationToken, configuration: TConfiguration) => Promise<Runtime>;
export type ConfigLessRuntimeFactory = (cancellationToken: CancellationToken) => Promise<Runtime>;

export function launcher(runtimeFactory: ConfigLessRuntimeFactory): void;

/**
 * Launch an application using `defaultConfigurationLoader`
 * @param configurationParser User's function that provides configuration parser
 * @param runtimeFactory User's function that compose and start runtime
 */
export function launcher<TConfiguration>(
	configurationParser: ConfigurationParser<TConfiguration>,
	runtimeFactory: RuntimeFactory<TConfiguration>
): void;

/**
 * Launch an application
 * @param configurationLoader User's function that provides configuration loader
 * @param configurationParser User's function that provides configuration parser
 * @param runtimeFactory User's function that compose and start runtime
 */
export function launcher<TConfiguration>(
	configurationLoader: RawConfigurationLoader,
	configurationParser: ConfigurationParser<TConfiguration>,
	runtimeFactory: RuntimeFactory<TConfiguration>
): void;

export function launcher<TConfiguration>(...args: Array<any>): void {
	const log = logger.getLogger("launcher");

	async function run() {
		let cancellationTokenSource: CancellationTokenSource = new ManualCancellationTokenSource();

		process.on("unhandledRejection", reason => {
			log.debug("Unhandled Rejection", reason);
			if (reason instanceof Error) {
				log.fatal(`Unhandled Rejection. ${reason.constructor.name}: ${reason.message}`);
			} else {
				log.fatal("Unhandled Rejection", reason);
			}
			process.exit(255);
		});

		let destroyRequestCount = 0;
		const shutdownSignals: Array<NodeJS.Signals> = ["SIGTERM", "SIGINT"];

		interface ConfigurationStaff {
			readonly loader: RawConfigurationLoader;
			readonly parser: ConfigurationParser<TConfiguration>;
		}

		let runtimeStuff:
			{
				readonly loader: RawConfigurationLoader;
				readonly parser: ConfigurationParser<TConfiguration>;
				readonly runtimeFactory: RuntimeFactory<TConfiguration>
			}
			| { readonly parser: null; readonly runtimeFactory: ConfigLessRuntimeFactory };

		let runtimeFactory: RuntimeFactory<TConfiguration>;
		if (args.length === 3 && typeof args[0] === "function" && typeof args[1] === "function") {
			runtimeStuff = Object.freeze({
				loader: args[0], parser: args[1], runtimeFactory: args[2]
			});
		} else if (args.length === 2 && typeof args[0] === "function" && typeof args[1] === "function") {
			runtimeStuff = Object.freeze({
				loader: defaultConfigurationLoader, parser: args[0], runtimeFactory: args[1]
			});
		} else if (args.length === 1 && typeof args[0] === "function") {
			runtimeStuff = Object.freeze({
				parser: null, runtimeFactory: args[0]
			});
		} else {
			throw new Error("Wrong arguments");
		}

		let runtime: Runtime;
		try {
			if (runtimeStuff.parser === null) {
				runtime = await runtimeStuff.runtimeFactory(cancellationTokenSource.token);
			} else {
				const rawConfiguration: RawConfiguration = await runtimeStuff.loader(cancellationTokenSource.token);
				const parsedConfiguration: TConfiguration = runtimeStuff.parser(rawConfiguration);
				runtime = await runtimeStuff.runtimeFactory(cancellationTokenSource.token, parsedConfiguration);
			}

			shutdownSignals.forEach((signal: NodeJS.Signals) => process.on(signal, () => gracefulShutdown(signal)));

		} catch (e) {
			if (e instanceof CancelledError) {
				log.warn("Runtime initialization was cancelled by user");
				process.exit(0);
			}
			if (log.isFatalEnabled) {
				if (e instanceof Error) {
					log.fatal(`Runtime initialization failed with ${e.constructor.name}: ${e.message}`);
				} else {
					log.fatal(`Runtime initialization failed with error: ${e}`);
				}
			}
			log.debug("Runtime initialization failed", e);
			process.exit(127);
		}

		async function gracefulShutdown(signal: string) {
			if (destroyRequestCount++ === 0) {
				cancellationTokenSource.cancel();

				if (log.isInfoEnabled) {
					log.info(`Interrupt signal received: ${signal}`);
				}
				await runtime.destroy();
				process.exit(0);
			} else {
				if (log.isInfoEnabled) {
					log.info(`Interrupt signal (${destroyRequestCount}) received: ${signal}`);
				}
			}
		}
	}

	log.info("Starting application...");
	run()
		.then(() => {
			if (log.isInfoEnabled) {
				log.info(`Application was started. Process ID: ${process.pid}`);
			}
		})
		.catch(reason => {
			if (log.isFatalEnabled) {
				if (reason instanceof LaunchError) {
					log.fatal(`Cannot launch the application due an ${reason.constructor.name}: ${reason.message}`);
				} else {
					log.fatal(reason.message, reason);
				}
			}
			if (process.env.NODE_ENV === "development") {
				setTimeout(() => process.exit(127), 1000);
			} else {
				process.exit(127);
			}
		});
}

export async function defaultConfigurationLoader(cancellationToken: CancellationToken): Promise<RawConfiguration> {
	const chainItems: Array<RawConfiguration> = [];
	for (const arg of process.argv) {
		if (arg.startsWith(defaultConfigurationLoader.CONFIG_FILE_ARG)) {
			const configFile = arg.substring(defaultConfigurationLoader.CONFIG_FILE_ARG.length);
			const fileConf: RawConfiguration = await fileConfiguration(configFile);
			chainItems.push(fileConf);
		} else if (arg.startsWith(defaultConfigurationLoader.CONFIG_SECRET_DIR_ARG)) {
			const secretsDir = arg.substring(defaultConfigurationLoader.CONFIG_SECRET_DIR_ARG.length);
			const secretsConfiguration = await secretsDirectoryConfiguration(secretsDir);
			chainItems.push(secretsConfiguration);
		} else if (arg === defaultConfigurationLoader.CONFIG_ENV_ARG) {
			const envConf = envConfiguration();
			chainItems.push(envConf);
		}
	}

	if (chainItems.length === 0) {
		throw new LaunchError(
			"Missing configuration. Please provide at least one of: " +
			`${defaultConfigurationLoader.CONFIG_ENV_ARG}, ${defaultConfigurationLoader.CONFIG_FILE_ARG}, ${defaultConfigurationLoader.CONFIG_SECRET_DIR_ARG}`
		);
	}

	chainItems.reverse();
	const rawConfiguration: RawConfiguration = chainConfiguration(...chainItems);

	return rawConfiguration;
}
export namespace defaultConfigurationLoader {
	export const CONFIG_ENV_ARG = "--config-env";
	export const CONFIG_FILE_ARG = "--config-file=";
	export const CONFIG_SECRET_DIR_ARG = "--config-secrets-dir=";
}

export default launcher;

export class LaunchError extends Error { }
