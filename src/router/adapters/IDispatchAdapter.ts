export interface DispatchMessage {
  role: string;
  content: string;
}

export interface DispatchRequest {
  model: string;
  messages: DispatchMessage[];
  [key: string]: any;
}

export interface DispatchResponse {
  tokens: number;
  latency: number;
  cost?: number;
  response: any;
  model: string;
}

export interface IDispatchAdapter {
  dispatch(request: DispatchRequest): Promise<DispatchResponse>;
  healthCheck(): Promise<boolean>;
}
