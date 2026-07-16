const requiredEnvironment = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
  "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
];

const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]?.trim());

if (missingEnvironment.length > 0) {
  throw new Error(`Missing Azure Trusted Signing configuration: ${missingEnvironment.join(", ")}`);
}

module.exports = {
  extends: "./electron-builder.yml",
  win: {
    signAndEditExecutable: true,
    azureSignOptions: {
      endpoint: process.env.AZURE_TRUSTED_SIGNING_ENDPOINT,
      certificateProfileName: process.env.AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME,
      codeSigningAccountName: process.env.AZURE_TRUSTED_SIGNING_ACCOUNT_NAME,
    },
  },
};
