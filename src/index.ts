import { Configuration } from "@zxteam/contract";
import * as cfg from "@zxteam/configuration";

import * as fs from "fs";
import * as util from "util";

const readFile = util.promisify(fs.readFile);

import loggerFactory from "@zxteam/logger";

export interface Runtime {
	destroy(): Promise<void>;
}

export type ConfigurationFactory<T> = () => Promise<T>;

export type RuntimeFactory<T> = (configuration: T) => Promise<Runtime>;

export function launcher<T>(runtimeFactory: RuntimeFactory<T>): void;
export function launcher<T>(configurationFactory: ConfigurationFactory<T>, runtimeFactory: RuntimeFactory<T>): void;

export function launcher<T>(...args: Array<any>): void {
	const log = loggerFactory.getLogger("launcher");

	async function run() {
		process.on("unhandledRejection", reason => {
			log.fatal("Unhandled Rejection", reason);
			process.exit(255);
		});

		let configurationFactory: ConfigurationFactory<T>;
		let runtimeFactory: RuntimeFactory<T>;
		if (args.length === 1 && typeof args[0] === "function") {
			configurationFactory = jsonConfigurationFactory;
			runtimeFactory = args[0];
		} else if (args.length === 2 && typeof args[0] === "function" && typeof args[1] === "function") {
			configurationFactory = args[0];
			runtimeFactory = args[1];
		} else {
			throw new Error("Wrong arguments");
		}

		const configuration = await configurationFactory();
		const runtime = await runtimeFactory(configuration);

		let destroyRequestCount = 0;
		async function gracefulShutdown(signal: string) {
			if (destroyRequestCount++ === 0) {
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

		const shutdownSignals: Array<NodeJS.Signals> = ["SIGTERM", "SIGINT"];
		shutdownSignals.forEach((signal: NodeJS.Signals) => process.on(signal, () => gracefulShutdown(signal)));
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
					log.fatal(`Cannot launch the application due an error: ${reason.message}`);
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

export function jsonConfigurationFactory(): Promise<any> {
	return Promise.resolve().then(async () => {
		const configFileArg = process.argv.find(w => w.startsWith("--config="));
		if (configFileArg !== undefined) {
			const configFile = configFileArg.substring(9); // Cut --config=
			const configFileData = await readFile(configFile);
			const configuration = JSON.parse(configFileData.toString());
			return configuration;
		}
		throw new LaunchError("An argument --config is not passed");
	});
}

export function fileConfigurationFactory<T>(parser: (configuration: Configuration) => T): Promise<T> {
	return Promise.resolve().then(() => {
		const configFileArg = process.argv.find(w => w.startsWith("--config="));
		if (configFileArg !== undefined) {
			const configFile = configFileArg.substring(9); // Cut --config=
			return parser(cfg.fileConfiguration(configFile));
		}
		throw new LaunchError("An argument --config is not passed");
	});
}



export default launcher;


export class LaunchError extends Error { }
