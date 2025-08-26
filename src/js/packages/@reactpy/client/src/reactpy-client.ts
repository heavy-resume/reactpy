import logger from "./logger";
import { ReactPyModule } from "./reactpy-vdom";

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

  onLayoutUpdate(handler: (path: string, model: any) => void): void;

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
  protected debugMessages: boolean;
  protected layoutUpdateHandlers: Array<(path: string, model: any) => void> = [];

  constructor() {
    this.resolveReady = () => { };
    this.ready = new Promise((resolve) => (this.resolveReady = resolve));
    this.stateVars = {};
    this.debugMessages = false;
  }

  onMessage(type: string, handler: (message: any) => void): () => void {
    (this.handlers[type] || (this.handlers[type] = [])).push(handler);
    this.resolveReady(undefined);
    return () => {
      this.handlers[type] = this.handlers[type].filter((h) => h !== handler);
    };
  }

  onLayoutUpdate(handler: (path: string, model: any) => void): void {
    this.layoutUpdateHandlers.push(handler);
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

    if (this.debugMessages) {
      logger.log("Got message", message);
    }

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
  idleDisconnectTimeSeconds?: number;
  connectionTimeout?: number;
  debugMessages?: boolean;
  socketLoopThrottle?: number;
  pingInterval?: number;
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
  reconnectingCallback?: () => void;
  reconnectedCallback?: () => void;
};

enum messageTypes {
  isReady = "is-ready",
  reconnectingCheck = "reconnecting-check",
  clientState = "client-state",
  stateUpdate = "state-update",
  layoutUpdate = "layout-update",
  pingIntervalSet = "ping-interval-set",
};

export class SimpleReactPyClient
  extends BaseReactPyClient
  implements ReactPyClient {
  private urls: ServerUrls;
  private socket!: { current?: WebSocket };
  private idleDisconnectTimeMillis: number;
  private lastActivityTime: number;
  private reconnectOptions: ReconnectProps | undefined;
  private messageQueue: any[] = [];
  private socketLoopIntervalId?: number | null;
  private idleCheckIntervalId?: number | null;
  private sleeping: boolean;
  private isReconnecting: boolean;
  private isReady: boolean;
  private salt: string;
  private shouldReconnect: boolean;
  private connectionTimeout: number;
  private reconnectingCallback: () => void;
  private reconnectedCallback: () => void;
  private didReconnectingCallback: boolean;
  private willReconnect: boolean;
  private socketLoopThrottle: number;
  private pingPongIntervalId?: number | null;
  private pingInterval: number;
  private messageResponseTimeoutId?: number | null;

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
    this.connectionTimeout = props.connectionTimeout || 5000;
    this.pingInterval = props.pingInterval || 0;
    this.lastActivityTime = Date.now()
    this.reconnectOptions = props.reconnectOptions
    this.debugMessages = props.debugMessages || false;
    this.socketLoopThrottle = props.socketLoopThrottle || 5;
    this.sleeping = false;
    this.isReconnecting = false;
    this.willReconnect = false;
    this.isReady = false
    this.salt = "";
    this.shouldReconnect = false;
    this.didReconnectingCallback = false;
    this.reconnectingCallback = props.reconnectOptions?.reconnectingCallback || this.showReconnectingGrayout;
    this.reconnectedCallback = props.reconnectOptions?.reconnectedCallback || this.hideReconnectingGrayout;

    this.onMessage(messageTypes.reconnectingCheck, () => { this.indicateReconnect() })
    this.onMessage(messageTypes.isReady, (msg) => { this.isReady = true; this.salt = msg.salt; });
    this.onMessage(messageTypes.clientState, () => { this.sendClientState() });
    this.onMessage(messageTypes.stateUpdate, (msg) => { this.updateClientState(msg.state_vars) });
    this.onMessage(messageTypes.layoutUpdate, (msg) => {
      this.updateClientState(msg.state_vars);
      this.invokeLayoutUpdateHandlers(msg.path, msg.model);
      this.willReconnect = true;  // don't indicate a reconnect until at least one successful layout update
    });
    this.onMessage(messageTypes.pingIntervalSet, (msg) => { this.pingInterval = msg.ping_interval; this.updatePingInterval(); });
    this.updatePingInterval()
    this.reconnect()

    const handleUserAction = (ev: any) => {
      this.lastActivityTime = Date.now();
      if (!this.isReady && !this.isReconnecting) {
        this.sleeping = false;
        this.reconnect();
      }
    }

    window.addEventListener('mousemove', handleUserAction);
    window.addEventListener('scroll', handleUserAction);
  }

  protected invokeLayoutUpdateHandlers(path: string, model: any) {
    this.layoutUpdateHandlers.forEach(func => {
      func(path, model);
    });
  }

  protected showReconnectingGrayout() {
    const overlay = document.createElement('div');
    overlay.id = 'reactpy-reconnect-overlay';

    const pipeContainer = document.createElement('div');
    const pipeSymbol = document.createElement('div');
    pipeSymbol.textContent = '|'; // Set the pipe symbol

    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(0,0,0,0.5);
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 100000;
    `;

    pipeContainer.style.cssText = `
      display: flex;
      justify-content: center;
      align-items: center;
      width: 40px;
      height: 40px;
    `;

    pipeSymbol.style.cssText = `
      font-size: 24px;
      color: #FFF;
      display: inline-block;
      width: 100%;
      height: 100%;
      text-align: center;
      transform-origin: center;
    `;

    pipeContainer.appendChild(pipeSymbol);
    overlay.appendChild(pipeContainer);
    document.body.appendChild(overlay);

    // Create and start the spin animation
    let angle = 0;
    function spin() {
      angle = (angle + 2) % 360; // Adjust rotation speed as needed
      pipeSymbol.style.transform = `rotate(${angle}deg)`;
      requestAnimationFrame(spin);
    }
    spin();
  }

  hideReconnectingGrayout() {
    const overlay = document.getElementById('reactpy-reconnect-overlay');
    if (overlay && overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
  }

  indicateReconnect(): void {
    const isReconnecting = this.willReconnect ? "yes" : "no";
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
      if (this.debugMessages) {
        logger.log("Sending message", message);
      }
      this.lastActivityTime = Date.now();
      this.socket.current.send(JSON.stringify(message));

      // Start response timeout for reconnecting grayout
      if (this.messageResponseTimeoutId) {
        window.clearTimeout(this.messageResponseTimeoutId);
      }
      this.messageResponseTimeoutId = window.setTimeout(() => {
        this.showReconnectingGrayout();
      }, 800);
    }
  }

  protected handleIncoming(message: any): void {
    super.handleIncoming(message);
  }

  idleTimeoutCheck(): void {
    if (!this.socket)
      return;
    if (Date.now() - this.lastActivityTime > this.idleDisconnectTimeMillis) {
      if (this.socket.current && this.socket.current.readyState === WebSocket.OPEN) {
        logger.warn("Closing socket connection due to idle activity");
        this.sleeping = true;
        this.isReconnecting = false;
        this.socket.current.close();
      }
    }
  }

  updatePingInterval(): void {
    if (this.pingPongIntervalId) {
      window.clearInterval(this.pingPongIntervalId);
    }
    if (this.pingInterval) {
      this.pingPongIntervalId = window.setInterval(() => { this.socket.current?.readyState === WebSocket.OPEN && this.socket.current?.send("ping") }, this.pingInterval);
    }
  }

  reconnect(onOpen?: () => void, interval: number = 750, connectionAttemptsRemaining: number = 20, lastAttempt: number = 0): void {
    const intervalJitter = this.reconnectOptions?.intervalJitter || 0.5;
    const backoffRate = this.reconnectOptions?.backoffRate || 1.2;
    const maxInterval = this.reconnectOptions?.maxInterval || 500;
    const maxRetries = this.reconnectOptions?.maxRetries || 40;

    if (this.layoutUpdateHandlers.length == 0) {
      setTimeout(() => { this.reconnect(onOpen, interval, connectionAttemptsRemaining, lastAttempt); }, 10);
      return
    }

    if (connectionAttemptsRemaining <= 0) {
      logger.warn("Giving up on reconnecting (hit retry limit)");
      this.shouldReconnect = false;
      this.isReconnecting = false;
      return
    }

    if (this.shouldReconnect) {
      // already reconnecting
      return;
    }
    lastAttempt = lastAttempt || Date.now();
    this.shouldReconnect = true;

    this.urls = getServerUrls(
      {
        url: document.location.origin,
        route: document.location.pathname,
        query: document.location.search,
      },
    );

    window.setTimeout(() => {
      if (!this.didReconnectingCallback && this.reconnectingCallback && maxRetries != connectionAttemptsRemaining) {
        this.didReconnectingCallback = true;
        this.reconnectingCallback();
      }

      if (maxRetries < connectionAttemptsRemaining)
        connectionAttemptsRemaining = maxRetries;

      this.socket = createWebSocket({
        connectionTimeout: this.connectionTimeout,
        readyPromise: this.ready,
        url: this.urls.stream,
        onOpen: () => {
          lastAttempt = Date.now();
          if (this.reconnectedCallback) {
            this.reconnectedCallback();
            this.didReconnectingCallback = false;
          }
          if (onOpen)
            onOpen();
        },
        onClose: () => {
          // reset retry interval on successful connection
          if (Date.now() - lastAttempt > maxInterval * 2) {
            interval = 750;
            connectionAttemptsRemaining = maxRetries;
          } else if (!this.sleeping) {
            this.isReconnecting = true;
          }
          lastAttempt = Date.now()
          this.shouldReconnect = false;
          this.isReady = false;
          if (this.socketLoopIntervalId)
            clearInterval(this.socketLoopIntervalId);
          if (this.idleCheckIntervalId)
            clearInterval(this.idleCheckIntervalId);
          if (this.pingPongIntervalId)
            clearInterval(this.pingPongIntervalId);
          if (!this.sleeping) {
            const thisInterval = nextInterval(addJitter(interval, intervalJitter), backoffRate, maxInterval);
            const newRetriesRemaining = connectionAttemptsRemaining - 1;
            logger.log(
              `reconnecting in ${(thisInterval / 1000).toPrecision(4)} seconds... (${newRetriesRemaining} retries remaining)`,
            );
            this.reconnect(onOpen, thisInterval, newRetriesRemaining, lastAttempt);
          }
        },
        onMessage: async ({ data }) => {
          this.lastActivityTime = Date.now();
          if (this.messageResponseTimeoutId) {
            window.clearTimeout(this.messageResponseTimeoutId);
            this.messageResponseTimeoutId = null;
            this.hideReconnectingGrayout();
          }
          this.handleIncoming(JSON.parse(data));
        },
        ...this.reconnectOptions,
      });
      this.socketLoopIntervalId = window.setInterval(() => { this.socketLoop() }, this.socketLoopThrottle);
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
    this.lastActivityTime = Date.now()
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
      if (socket.current && socket.current.readyState !== WebSocket.OPEN) {
        socket.current.close();
        console.error('Connection attempt timed out');
      }
    }, connectionTimeout);
    socket.current.onopen = () => {
      clearTimeout(timeoutId);
      everConnected = true;
      logger.log("client connected");
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
  return interval + (Math.random() * jitter * interval);
}

function rtrim(text: string, trim: string): string {
  return text.replace(new RegExp(`${trim}+$`), "");
}
