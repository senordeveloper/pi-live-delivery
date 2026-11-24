import type { DeliveryContext } from '../delivery/context.js';

export const DEFAULT_BASE_PATH = '/live-delivery';

export type CdConfig = DeliveryContext & {
  port: number;
  basePath: string;
  bindHost?: string;
  accessToken?: string;
  dashboardFile?: string;
  openBrowser?: 'auto' | 'never' | 'always';
  readOnly?: boolean;
};
