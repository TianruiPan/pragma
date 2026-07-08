export type FrameRole = "page" | "components" | "assets";

export interface CaptureRepo {
  owner: string;
  name: string;
  localPath?: string;
}

export interface CaptureIssue {
  number: number;
  title?: string;
}

export interface CaptureFrame {
  nodeId: string;
  name: string;
  type?: string;
  width?: number;
  height?: number;
  role?: FrameRole;
  optional?: boolean;
  url?: string;
}

export interface CaptureFrames {
  page: CaptureFrame[];
  components?: CaptureFrame[];
  assets?: CaptureFrame[];
}

export interface CaptureRequest {
  repo: CaptureRepo;
  designIssue: CaptureIssue;
  targetDevIssues?: CaptureIssue[];
  figma: {
    fileKey: string;
    fileName?: string;
    url?: string;
    nodeIds?: string[];
    selectionMode?: string;
    frames: CaptureFrames;
  };
  blueLakeUrl?: string;
  designerNotes?: string;
  dynamicRegionNotes?: string;
  capturedAt?: string;
}

export interface BundleFile {
  path: string;
  kind: "json" | "text" | "binary";
  content?: unknown;
  base64?: string;
  mime?: string;
  checksum?: string;
}

export interface PragmaInputBundle {
  schemaVersion: "2.0";
  kind: "pragma-figma-capture-bundle";
  createdAt: string;
  files: BundleFile[];
  summary?: Record<string, unknown>;
}

export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}
