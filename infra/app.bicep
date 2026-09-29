targetScope = 'resourceGroup'

@allowed(['brazilsouth'])
param location string = 'brazilsouth'
param acrName string
param environmentName string
param identityName string
param storageAccountName string
param storageContainerName string = 'demo-state'
param openAiAccountName string
param openAiDeploymentName string = 'teacher-reasoning'
param openAiApiVersion string = '2025-04-01-preview'
param appName string
param jobName string
@description('Tenant of the statically registered OAuth API/client.')
@minLength(36)
param mcpEntraTenantId string
@minLength(36)
param mcpEntraClientId string
@description('Comma-separated object IDs allowed to access this private synthetic demo.')
@minLength(36)
param mcpEntraAllowedOids string
@description('Opt-in diagnostic harness only; not Microsoft Copilot Autopilot. Native Autopilot owns user schedules.')
param deployDemoScheduler bool = false
@description('Capture metadata-only consumption receipts; not authoritative billing records.')
param enableCostMetering bool = false
@description('Full ACR image URI with an explicit immutable release tag.')
@minLength(1)
param image string
@secure()
@minLength(32)
param demoAccessKey string
@secure()
@minLength(32)
param mcpAccessKey string

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}
resource environment 'Microsoft.App/managedEnvironments@2025-01-01' existing = {
  name: environmentName
}
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}
resource openAi 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: openAiAccountName
}

var tags = {
  project: 'education-ai-horizonte'
  data: 'synthetic-only'
}
// Use the environment domain rather than referencing the app being created.
var publicOrigin = 'https://${appName}.${environment.properties.defaultDomain}'
var serviceIdentity = {
  type: 'UserAssigned'
  userAssignedIdentities: {
    '${identity.id}': {}
  }
}
var registries = [
  {
    server: acr.properties.loginServer
    identity: identity.id
  }
]
var modelStateEnv = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
  { name: 'AZURE_STORAGE_ACCOUNT', value: storage.name }
  { name: 'AZURE_STORAGE_CONTAINER', value: storageContainerName }
  { name: 'AZURE_OPENAI_ENDPOINT', value: openAi.properties.endpoint }
  { name: 'AZURE_OPENAI_DEPLOYMENT', value: openAiDeploymentName }
  { name: 'AZURE_OPENAI_API_VERSION', value: openAiApiVersion }
  { name: 'AUTOPILOT_SCHEDULE', value: '06:30 em dias uteis (America/Sao_Paulo)' }
]

resource app 'Microsoft.App/containerApps@2025-01-01' = {
  name: appName
  location: location
  tags: tags
  identity: serviceIdentity
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 8080
        transport: 'http'
      }
      registries: registries
      secrets: [
        { name: 'demo-access-key', value: demoAccessKey }
        { name: 'mcp-access-key', value: mcpAccessKey }
      ]
    }
    template: {
      containers: [
        {
          name: 'horizonte'
          image: image
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: concat(modelStateEnv, [
            { name: 'PORT', value: '8080' }
            { name: 'TRUST_PROXY_HOPS', value: '1' }
            { name: 'COST_METERING_ENABLED', value: string(enableCostMetering) }
            { name: 'COST_LOG_RECEIPTS', value: string(enableCostMetering) }
            { name: 'COST_CONTAINER_VCPU', value: '0.25' }
            { name: 'COST_CONTAINER_MEMORY_GIB', value: '0.5' }
            { name: 'PUBLIC_ORIGIN', value: publicOrigin }
            { name: 'DEMO_ACCESS_KEY', secretRef: 'demo-access-key' }
            { name: 'MCP_ACCESS_KEY', secretRef: 'mcp-access-key' }
            { name: 'MCP_ENTRA_TENANT_ID', value: mcpEntraTenantId }
            { name: 'MCP_ENTRA_CLIENT_ID', value: mcpEntraClientId }
            { name: 'MCP_ENTRA_ALLOWED_OIDS', value: mcpEntraAllowedOids }
            { name: 'MCP_ENTRA_SCOPE', value: 'access_as_user' }
          ])
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/healthz', port: 8080, scheme: 'HTTP' }
              periodSeconds: 5
              timeoutSeconds: 3
              failureThreshold: 30
            }
            {
              type: 'Liveness'
              httpGet: { path: '/healthz', port: 8080, scheme: 'HTTP' }
              periodSeconds: 30
              timeoutSeconds: 3
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/healthz', port: 8080, scheme: 'HTTP' }
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 1
        rules: [
          {
            name: 'http'
            http: { metadata: { concurrentRequests: '10' } }
          }
        ]
      }
    }
  }
}

resource job 'Microsoft.App/jobs@2025-01-01' = if (deployDemoScheduler) {
  name: jobName
  location: location
  tags: union(tags, { purpose: 'diagnostic-harness-only' })
  identity: serviceIdentity
  properties: {
    environmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 180
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: '30 9 * * 1-5'
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: registries
    }
    template: {
      containers: [
        {
          name: 'drafts'
          image: image
          command: [ 'node', 'dist/server/job.js' ]
          env: modelStateEnv
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
        }
      ]
    }
  }
}

output appName string = app.name
output jobName string = jobName
output schedulerDeployed bool = deployDemoScheduler
output appFqdn string? = app.properties.configuration.?ingress.?fqdn
output appUrl string? = empty(app.properties.configuration.?ingress.?fqdn)
  ? null
  : 'https://${app.properties.configuration.ingress.fqdn}'
output identityClientId string = identity.properties.clientId
