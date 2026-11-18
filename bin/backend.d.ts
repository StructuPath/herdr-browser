export interface Backend {
  open(url: string): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  click(x: number, y: number): Promise<void>;
  scroll(direction: string, pixels: number): Promise<void>;
  type(text: string): Promise<void>;
  sessionExists(): Promise<boolean>;
  snapshotText(): Promise<{ title: string; lines: string[] }>;
  networkRequests(): Promise<{ title: string; lines: string[] }>;

  snapshot?(file: string): Promise<{ url: string; title: string; entries: any[] }>;
  setViewport?(width: number, height: number): Promise<void>;
  streamEnable?(): Promise<void>;
  streamStatus?(): Promise<{ port?: number }>;
  network?(): Promise<any[]>;

  connect?(): Promise<{
    host: string; port: string; browser: string | null; guid: string | null;
    rediscoverable: boolean; targetId: string | null; url: string; title: string;
  }>;
  onMessage?(handler: (message: any) => void): void;
  attachTime?(): number;
  ackFrame?(ackId: number, generation: number): Promise<void>;
  restartScreencast?(): Promise<void>;
  listTargets?(): Promise<{ targetId: string; url: string; title: string; selected: boolean }[]>;
  selectTarget?(targetId: string): Promise<void>;
  screenshot?(file: string): Promise<void>;
  close?(): void;
}
