export interface VerifyResponse {
  errorMessage: string | null;
  username: string | null;
  valid: boolean;
}

export interface MyPackageDto {
  package_id: number;
  status: string;
  description: string;
  total_package_size: number;
  has_associated_files: boolean;
  created_date: string;
  package_type: string;
  source_package_id: number | null;
  source_package_description: string | null;
  permission_group: string | null;
  file_count: number;
}

export interface SharedPackageDto {
  userId: number;
  dataRepositoryId: number;
  dataRepositoryName: string;
  dataRepositoryDesc: string;
  packageId: number;
  packageName: string;
  createdDate: string;
  fileCount: number;
  fileSize: number;
  packageDescription: string;
}

export interface PackageFileDto {
  download_alias: string;
  file_size: number;
  is_associated_file: boolean;
  created_date: string;
  is_data_file: boolean;
  is_document_file: boolean;
  nda_file_type: string;
  associatedFile: boolean;
  dataFile: boolean;
  documentFile: boolean;
  package_file_id: number;
}

export interface PackageFilesResponse {
  results: PackageFileDto[];
}

export interface DownloadTokenResponse {
  package_file_id: number;
  download_alias: string;
  access_key: string;
  secret_key: string;
  session_token: string;
  expiration_date: string;
  destination_uri: string | null;
  source_uri: string;
}

export interface AuthState {
  host: string;
  sessionId: string | null;
  token: string | null;
  username: string | null;
  authenticated: boolean;
  lastVerifiedAt: string | null;
}

export type LocalFileStatus = 'unknown' | 'missing' | 'downloaded' | 'partial';

export interface UiPackage {
  id: number;
  name: string;
  description: string;
  fileCount: number;
  fileSize: number;
  createdDate: string;
  source: 'mine' | 'shared';
  status?: string;
  raw: MyPackageDto | SharedPackageDto;
}

export interface UiFile extends PackageFileDto {
  selected: boolean;
  localStatus: LocalFileStatus;
  localSize: number | null;
  localModifiedAt: string | null;
  downloadStatus: string | null;
  receivedBytes: number;
  totalBytes: number;
  errorMessage: string | null;
}
