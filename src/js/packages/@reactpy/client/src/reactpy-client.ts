import { ReactPyModule } from "./reactpy-vdom";
import logger from "./logger";

/**
 * A client for communicating with a ReactPy server.
 */
export interface ReactPyClient {
  /**
   * Register a handler for a message type.
   *
   * The first time this is called, the client will be considered ready.
   *
   * @param type The type of message to handle.
   * @param handler The handler to call when a message of the given type is received.
   * @returns A function to unregister the handler.
   */
  onMessage(type: string, handler: (message: any) => void): () => void;

  /**
   * Send a message to the server.
   *
   * @param message The message to send. Messages must have a `type` property.
   */
  sendMessage(message: any): void;

  /**
   * Load a module from the server.
   * @param moduleName The name of the module to load.
   * @returns A promise that resolves to the module.
   */
  loadModule(moduleName: string): Promise<ReactPyModule>;

  /**
   * Update state vars from the server for reconnections
   * @param givenStateVars State vars to store
   */
  updateStateVars(givenStateVars: object): void;
}

export abstract class BaseReactPyClient implements ReactPyClient {
  private readonly handlers: { [key: string]: ((message: any) => void)[] } = {};
  protected readonly ready: Promise<void>;
  private resolveReady: (value: undefined) => void;
  protected stateVars: object;

  constructor() {
    this.resolveReady = () => { };
    this.ready = new Promise((resolve) => (this.resolveReady = resolve));
    this.stateVars = {};
  }

  onMessage(type: string, handler: (message: any) => void): () => void {
    (this.handlers[type] || (this.handlers[type] = [])).push(handler);
    this.resolveReady(undefined);
    return () => {
      this.handlers[type] = this.handlers[type].filter((h) => h !== handler);
    };
  }

  abstract sendMessage(message: any): void;
  abstract loadModule(moduleName: string): Promise<ReactPyModule>;

  updateStateVars(givenStateVars: object): void {
    this.stateVars = Object.assign(this.stateVars, givenStateVars);
  }

  /**
   * Handle an incoming message.
   *
   * This should be called by subclasses when a message is received.
   *
   * @param message The message to handle. The message must have a `type` property.
   */
  protected handleIncoming(message: any): void {
    if (!message.type) {
      logger.warn("Received message without type", message);
      return;
    }

    logger.log("Got message", message);

    const messageHandlers: ((m: any) => void)[] | undefined =
      this.handlers[message.type];
    if (!messageHandlers) {
      logger.warn("Received message without handler", message);
      return;
    }

    messageHandlers.forEach((h) => h(message));
  }
}

export type SimpleReactPyClientProps = {
  serverLocation?: LocationProps;
  reconnectOptions?: ReconnectProps;
  forceRerender?: boolean;
  idleDisconnectTimeSeconds?: number;
  connectionTimeout?: number;
};

/**
 * The location of the server.
 *
 * This is used to determine the location of the server's API endpoints. All endpoints
 * are expected to be found at the base URL, with the following paths:
 *
 * - `_reactpy/stream/${route}${query}`: The websocket endpoint for the stream.
 * - `_reactpy/modules`: The directory containing the dynamically loaded modules.
 * - `_reactpy/assets`: The directory containing the static assets.
 */
type LocationProps = {
  /**
   * The base URL of the server.
   *
   * @default - document.location.origin
   */
  url: string;
  /**
   * The route to the page being rendered.
   *
   * @default - document.location.pathname
   */
  route: string;
  /**
   * The query string of the page being rendered.
   *
   * @default - document.location.search
   */
  query: string;
};

type ReconnectProps = {
  maxInterval?: number;
  maxRetries?: number;
  backoffRate?: number;
  intervalJitter?: number;
};

enum messageTypes {
  isReady = "is-ready",
  reconnectingCheck = "reconnecting-check",
  clientState = "client-state",
  stateUpdate = "state-update"
};

export class SimpleReactPyClient
  extends BaseReactPyClient
  implements ReactPyClient {
  private readonly urls: ServerUrls;
  private socket!: { current?: WebSocket };
  private idleDisconnectTimeMillis: number;
  private lastMessageTime: number;
  private reconnectOptions: ReconnectProps | undefined;
  // @ts-ignore
  private forceRerender: boolean;
  private messageQueue: any[] = [];
  private socketLoopIntervalId?: number | null;
  private idleCheckIntervalId?: number | null;
  private sleeping: boolean;
  private isReconnecting: boolean;
  private isReady: boolean;
  private salt: string;
  private shouldReconnect: boolean;
  private connectionTimeout: number;

  constructor(props: SimpleReactPyClientProps) {
    super();

    this.urls = getServerUrls(
      props.serverLocation || {
        url: document.location.origin,
        route: document.location.pathname,
        query: document.location.search,
      },
    );
    this.idleDisconnectTimeMillis = (props.idleDisconnectTimeSeconds || 240) * 1000;
    this.forceRerender = props.forceRerender !== undefined ? props.forceRerender : false;
    this.connectionTimeout = props.connectionTimeout || 5000;
    this.lastMessageTime = Date.now()
    this.reconnectOptions = props.reconnectOptions
    this.sleeping = false;
    this.isReconnecting = false;
    this.isReady = false
    this.salt = "";
    this.shouldReconnect = false;

    this.onMessage(messageTypes.reconnectingCheck, () => { this.indicateReconnect() })
    this.onMessage(messageTypes.isReady, (msg) => { this.isReady = true; this.salt = msg.salt; });
    this.onMessage(messageTypes.clientState, () => { this.sendClientState() });
    this.onMessage(messageTypes.stateUpdate, (msg) => { this.updateClientState(msg.state_vars) });

    this.reconnect()

    const reconnectOnUserAction = (ev: any) => {
      if (!this.isReady && !this.isReconnecting) {
        this.reconnect();
      }
    }

    window.addEventListener('mousemove', reconnectOnUserAction);
    window.addEventListener('scroll', reconnectOnUserAction);
  }

  indicateReconnect(): void {
    const isReconnecting = this.isReconnecting ? "yes" : "no";
    this.sendMessage({ "type": messageTypes.reconnectingCheck, "value": isReconnecting }, true)
  }

  sendClientState(): void {
    if (!this.socket)
      return;
    this.transmitMessage({
      "type": "client-state",
      "value": this.stateVars,
      "salt": this.salt
    });
  }

  updateClientState(stateVars: object): void {
    if (!this.socket)
      return;
    this.updateStateVars(stateVars)
  }

  socketLoop(): void {
    if (!this.socket)
      return;
    if (this.messageQueue.length > 0 && this.isReady && this.socket.current && this.socket.current.readyState === WebSocket.OPEN) {
      const message = this.messageQueue.shift(); // Remove the first message from the queue
      this.transmitMessage(message);
    }
  }

  transmitMessage(message: any): void {
    if (this.socket && this.socket.current) {
      logger.log("Sending message", message);
      this.socket.current.send(JSON.stringify(message));
    }
  }

  idleTimeoutCheck(): void {
    if (!this.socket)
      return;
    if (Date.now() - this.lastMessageTime > this.idleDisconnectTimeMillis) {
      if (this.socket.current && this.socket.current.readyState === WebSocket.OPEN) {
        logger.warn("Closing socket connection due to idle activity");
        this.sleeping = true;
        this.socket.current.close();
      }
    }
  }

  reconnect(onOpen?: () => void, interval: number = 750, retriesRemaining: number = 30, lastAttempt: number = 0): void {
    const intervalJitter = this.reconnectOptions?.intervalJitter || 0.5;
    const backoffRate = this.reconnectOptions?.backoffRate || 1.2;
    const maxInterval = this.reconnectOptions?.maxInterval || 20000;
    const maxRetries = this.reconnectOptions?.maxRetries || retriesRemaining;


    if (retriesRemaining <= 0) {
      this.shouldReconnect = false;
      return
    }

    if (this.shouldReconnect) {
      // already reconnecting
      return;
    }
    lastAttempt = lastAttempt || Date.now();
    this.shouldReconnect = true;

    window.setTimeout(() => {

      if (maxRetries > retriesRemaining)
        retriesRemaining = maxRetries;

      this.socket = createWebSocket({
        connectionTimeout: this.connectionTimeout,
        readyPromise: this.ready,
        url: this.urls.stream,
        onOpen: () => {
          lastAttempt = Date.now();
          if (onOpen)
            onOpen();
        },
        onClose: () => {
          // reset retry interval
          if (Date.now() - lastAttempt > maxInterval * 2) {
            interval = 750;
          }
          lastAttempt = Date.now()
          this.shouldReconnect = false;
          this.isReconnecting = true;
          this.isReady = false;
          if (this.socketLoopIntervalId)
            clearInterval(this.socketLoopIntervalId);
          if (this.idleCheckIntervalId)
            clearInterval(this.idleCheckIntervalId);
          if (!this.sleeping) {
            const thisInterval = nextInterval(addJitter(interval, intervalJitter), backoffRate, maxInterval);
            logger.log(
              `reconnecting in ${(thisInterval / 1000).toPrecision(4)} seconds...`,
            );
            this.reconnect(onOpen, thisInterval, retriesRemaining - 1, lastAttempt);
          }
        },
        onMessage: async ({ data }) => { this.lastMessageTime = Date.now(); this.handleIncoming(JSON.parse(data)) },
        ...this.reconnectOptions,
      });
      this.socketLoopIntervalId = window.setInterval(() => { this.socketLoop() }, 30);
      this.idleCheckIntervalId = window.setInterval(() => { this.idleTimeoutCheck() }, 10000);

    }, interval)
  }

  ensureConnected(): void {
    if (this.socket.current?.readyState == WebSocket.CLOSED) {
      this.reconnect();
    }
  }

  sendMessage(message: any, immediate: boolean = false): void {
    if (immediate) {
      this.transmitMessage(message);
    } else {
      this.messageQueue.push(message);
    }
    this.lastMessageTime = Date.now()
    this.sleeping = false;
    this.ensureConnected();
  }

  loadModule(moduleName: string): Promise<ReactPyModule> {
    return import(`${this.urls.modules}/${moduleName}`);
  }
}

type ServerUrls = {
  base: URL;
  stream: string;
  modules: string;
  assets: string;
};

function getServerUrls(props: LocationProps): ServerUrls {
  const base = new URL(`${props.url || document.location.origin}/_reactpy`);
  const modules = `${base}/modules`;
  const assets = `${base}/assets`;

  const streamProtocol = `ws${base.protocol === "https:" ? "s" : ""}`;
  const streamPath = rtrim(`${base.pathname}/stream${props.route || ""}`, "/");
  const stream = `${streamProtocol}://${base.host}${streamPath}${props.query}`;

  return { base, modules, assets, stream };
}

function createWebSocket(
  props: {
    url: string;
    readyPromise: Promise<void>;
    connectionTimeout: number;
    onOpen?: () => void;
    onMessage: (message: MessageEvent<any>) => void;
    onClose?: () => void;
  },
) {
  // const {
  //   maxInterval = 60000,
  //   maxRetries = 50,
  //   backoffRate = 1.1,
  //   intervalJitter = 0.1,
  // } = props;

  // const startInterval = 750;
  // let retries = 0;
  // let interval = startInterval;
  const closed = false;
  let everConnected = false;
  const socket: { current?: WebSocket } = {};

  const connect = () => {
    if (closed) {
      return;
    }
    socket.current = new WebSocket(props.url);
    const connectionTimeout = props.connectionTimeout; // Timeout in milliseconds

    const timeoutId = setTimeout(() => {
      // If the socket is still not open, close it to trigger the onerror event
      if (socket.current && socket.current.readyState !== WebSocket.OPEN) {
        socket.current.close();
        console.error('Connection attempt timed out');
      }
    }, connectionTimeout);
    socket.current.onopen = () => {
      clearTimeout(timeoutId);
      everConnected = true;
      logger.log("client connected");
      // interval = startInterval;
      // retries = 0;
      if (props.onOpen) {
        props.onOpen();
      }
    };
    socket.current.onmessage = props.onMessage;
    socket.current.onclose = () => {
      if (!everConnected) {
        logger.log("failed to connect");
      } else {
        logger.log("client disconnected");
      }
      if (props.onClose) {
        props.onClose();
      }

      //   if (retries >= maxRetries) {
      //     return;
      //   }

      //   const thisInterval = addJitter(interval, intervalJitter);
      //   logger.log(
      //     `reconnecting in ${(thisInterval / 1000).toPrecision(4)} seconds...`,
      //   );
      //   setTimeout(connect, thisInterval);
      //   interval = nextInterval(interval, backoffRate, maxInterval);
      //   retries++;
    };
  };

  props.readyPromise.then(() => logger.log("starting client...")).then(connect);

  return socket;
}

function nextInterval(
  currentInterval: number,
  backoffRate: number,
  maxInterval: number,
): number {
  return Math.min(
    (currentInterval *
      // increase interval by backoff rate
      backoffRate),
    // don't exceed max interval
    maxInterval,
  );
}

function addJitter(interval: number, jitter: number): number {
  return interval + (Math.random() * jitter * interval * 2 - jitter * interval);
}

function rtrim(text: string, trim: string): string {
  return text.replace(new RegExp(`${trim}+$`), "");
}
