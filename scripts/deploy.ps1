#Requires -Version 5.1
<#
.SYNOPSIS
Manually deploys Horizonte to its exclusive, existing Azure resource group.
.DESCRIPTION
Run deliberately from branch main on Windows with Azure CLI already signed in.
SecureWorkspacePath must be an existing, external, non-temporary local directory.
Its owner and protected (non-inherited) ACL must grant only the current user
FullControl. The same requirements apply to the credentials file's parent.
No existing workspace files or credentials are read or reused.

Capture the result: $result = & .\scripts\deploy.ps1 -SubscriptionId <guid> `
    -SecureWorkspacePath C:\SecureCredentials\HorizonteStaging
DemoAccessKey and McpAccessKey in the result are SecureString values, never log
text. Do not convert them to plaintext in transcripts or CI logs.

CredentialsOutputPath deliberately preserves plaintext JSON with a current-user
only ACL; it must be a fresh .json path. It is written BEFORE phase 2 and retained
even if deployment, health checking, or metadata persistence fails, since Azure
may already have accepted the keys. It is not evidence of deployment success.
Without this option, a failed deployment does not return keys: rerun to rotate
them. Transient parameter files are always removed in finally. Cleanup failures
are explicit failures, not successful deployments. ACL protection is not encryption.

Only nonsecret metadata is persisted to .runtime\deployment.json, after HTTPS
/healthz succeeds. The RBAC wait is bounded but cannot guarantee propagation.
No resource group creation, subscription switching, tool installation, secret
probing, automatic deployment rollback, or git mutations are performed.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')]
    [string]$SubscriptionId,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$SecureWorkspacePath,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$McpEntraTenantId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$McpEntraClientId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F-]{36}(,[0-9a-fA-F-]{36})*$')]
    [string]$McpEntraAllowedOids,

    [ValidateSet('rg-education-ai-horizonte')]
    [string]$ResourceGroupName = 'rg-education-ai-horizonte',

    [ValidatePattern('^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$')]
    [string]$ImageTag = ('deploy-' + [guid]::NewGuid().ToString('N')),

    [string]$CredentialsOutputPath,

    [ValidateRange(0, 600)]
    [int]$RolePropagationSeconds = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-PathWithin {
    param([string]$Path, [string]$Root)
    $prefix = $Root.TrimEnd('\')
    return ($Path.Equals($prefix, [StringComparison]::OrdinalIgnoreCase) -or
        $Path.StartsWith($prefix + '\', [StringComparison]::OrdinalIgnoreCase))
}

function Assert-NoReparsePath {
    param([string]$Path)
    $root = [IO.Path]::GetPathRoot($Path)
    $cursor = $root
    $parts = $Path.Substring($root.Length).Split('\', [StringSplitOptions]::RemoveEmptyEntries)
    # Walk from the volume down; never follow a junction to inspect its children.
    foreach ($part in @('') + $parts) {
        if ($part) { $cursor = Join-Path $cursor $part }
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Deployment paths must not contain reparse points, junctions, or symlinks.'
            }
        }
    }
}

function Resolve-ExternalPath {
    param([string]$Path, [string]$RepositoryRoot)
    # Reject UNC/device paths, alternate data streams, short-name aliases and
    # Win32 trailing-dot/space normalization before performing any file access.
    if ($Path -notmatch '^[A-Za-z]:\\' -or
        $Path.Substring(3) -match '[:*?"<>|/]' -or
        $Path -match '~[0-9]' -or
        $Path -match '[. ](\\|$)' -or
        $Path -match '(^|\\)(temp|tmp)(\\|$)') {
        throw 'Secure paths must be absolute local Windows paths, not temporary paths or aliases.'
    }
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if ($fullPath.Length -le 3 -or (Test-PathWithin $fullPath $RepositoryRoot) -or
        (Test-PathWithin $RepositoryRoot $fullPath)) {
        throw 'Secure paths must be outside the repository and must not be its ancestor or a volume root.'
    }
    $temporaryRoots = @($env:TEMP, $env:TMP, [IO.Path]::GetTempPath())
    if ($env:SystemRoot) { $temporaryRoots += (Join-Path $env:SystemRoot 'Temp') }
    foreach ($temporaryRoot in $temporaryRoots) {
        if ($temporaryRoot -and (Test-PathWithin $fullPath ([IO.Path]::GetFullPath($temporaryRoot)))) {
            throw 'Secure paths must not be in an operating-system temporary directory.'
        }
    }
    Assert-NoReparsePath $fullPath
    return $fullPath
}

function Assert-RepositoryMetadataPath {
    param([string]$Path, [string]$RepositoryRoot)
    if (-not (Test-PathWithin $Path $RepositoryRoot)) {
        throw 'Nonsecret deployment metadata must remain inside the repository.'
    }
    # The explicitly selected repository may live in OneDrive. Cloud placeholders
    # are not name-surrogate links; secrets still use the strict external check.
    $cursor = $RepositoryRoot
    $relative = $Path.Substring($RepositoryRoot.Length).TrimStart('\')
    foreach ($part in $relative.Split('\', [StringSplitOptions]::RemoveEmptyEntries)) {
        $cursor = Join-Path $cursor $part
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.LinkType) {
                throw 'Repository metadata paths must not follow junctions or symbolic links.'
            }
        }
    }
}

function Assert-PrivateAcl {
    param([string]$Path, [Security.Principal.SecurityIdentifier]$UserSid)
    Assert-NoReparsePath $Path
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected -or
        $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $UserSid.Value) {
        throw 'Secure directories/files must be current-user owned with inheritance disabled.'
    }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $fullControl = $false
    foreach ($rule in $rules) {
        if ($rule.IsInherited -or $rule.IdentityReference.Value -ne $UserSid.Value -or
            $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
            throw 'Secure directories/files must have only explicit allow rules for the current user.'
        }
        if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq
            [Security.AccessControl.FileSystemRights]::FullControl) {
            $fullControl = $true
        }
    }
    if (-not $fullControl) { throw 'The current user needs FullControl on the secure directory/file.' }
}

function New-PrivateAcl {
    param([Security.Principal.SecurityIdentifier]$UserSid, [switch]$Directory)
    if ($Directory) {
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $UserSid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    }
    else {
        $acl = New-Object Security.AccessControl.FileSecurity
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($UserSid, 'FullControl', 'Allow')
    }
    $acl.SetOwner($UserSid)
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule($rule)
    return $acl
}

function Write-PrivateJson {
    param(
        [string]$Path,
        [object]$Value,
        [Security.Principal.SecurityIdentifier]$UserSid
    )
    Assert-PrivateAcl ([IO.Path]::GetDirectoryName($Path)) $UserSid
    $stream = $null
    $created = $false
    $complete = $false
    $bytes = $null
    try {
        # CreateNew is atomic: even a concurrent invocation cannot overwrite a file.
        $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write, [IO.FileShare]::None)
        $created = $true
        $stream.Dispose()
        $stream = $null
        Set-Acl -LiteralPath $Path -AclObject (New-PrivateAcl $UserSid)
        Assert-PrivateAcl $Path $UserSid
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open,
            [IO.FileAccess]::Write, [IO.FileShare]::None)
        $json = ConvertTo-Json -InputObject $Value -Depth 12 -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($json)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        $complete = $true
    }
    catch { throw 'Could not create the protected JSON file; no secret content is included in this error.' }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
        $json = $null
        if ($created -and -not $complete) {
            Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
        }
    }
}

function Invoke-CheckedNative {
    param([string]$Executable, [string[]]$Arguments, [string]$Operation)
    $raw = $null
    try {
        # PS5.1 represents redirected native stderr as ErrorRecords. Suppress it
        # for ALL operations, especially phase 2, whose diagnostics may echo keys.
        $ErrorActionPreference = 'Continue'
        $PSNativeCommandUseErrorActionPreference = $false
        $raw = & $Executable @Arguments 2>$null
        $exitCode = $LASTEXITCODE
    }
    catch { throw "$Operation could not start. Native diagnostics are suppressed." }
    if ($exitCode -ne 0) {
        throw "$Operation failed (exit code $exitCode). Native diagnostics are suppressed."
    }
    return ($raw -join [Environment]::NewLine)
}

function ConvertFrom-CheckedJson {
    param([string]$Json, [string]$Operation)
    try {
        if ([string]::IsNullOrWhiteSpace($Json) -or -not $Json.TrimStart().StartsWith('{')) {
            throw 'Expected a JSON object.'
        }
        $value = ConvertFrom-Json -InputObject $Json -ErrorAction Stop
        if ($null -eq $value -or $value -is [array] -or $value -isnot [pscustomobject]) {
            throw 'Missing JSON object.'
        }
        return $value
    }
    catch { throw "$Operation did not return a valid JSON object. Raw output is suppressed." }
}

function Get-RequiredProperty {
    param([object]$Object, [string]$Name)
    if ($null -eq $Object -or $null -eq $Object.PSObject.Properties[$Name]) {
        throw "Required Azure JSON property '$Name' is missing."
    }
    return $Object.PSObject.Properties[$Name].Value
}

function Get-DeploymentOutputs {
    param([object]$Deployment, [string[]]$Names)
    $properties = Get-RequiredProperty $Deployment 'properties'
    if ((Get-RequiredProperty $properties 'provisioningState') -cne 'Succeeded') {
        throw 'Azure deployment did not report provisioningState Succeeded.'
    }
    $outputs = Get-RequiredProperty $properties 'outputs'
    if ($null -eq $outputs -or $outputs -isnot [pscustomobject]) {
        throw 'Azure deployment outputs are missing or null.'
    }
    $result = [ordered]@{}
    foreach ($name in $Names) {
        $entry = Get-RequiredProperty $outputs $name
        $value = Get-RequiredProperty $entry 'value'
        if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value)) {
            throw "Azure output '$name' must be a nonempty string; deployment is not ready."
        }
        $result[$name] = $value
    }
    return $result
}

function New-RandomKey {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
        return [Convert]::ToBase64String($bytes)
    }
    finally {
        $rng.Dispose()
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function Wait-AppHealth {
    param([uri]$AppUri)
    $healthUri = [uri]::new($AppUri, '/healthz')
    $oldProtocol = [Net.ServicePointManager]::SecurityProtocol
    try {
        [Net.ServicePointManager]::SecurityProtocol = $oldProtocol -bor [Net.SecurityProtocolType]::Tls12
        for ($attempt = 1; $attempt -le 30; $attempt++) {
            try {
                $response = Invoke-WebRequest -Uri $healthUri -Method Get -UseBasicParsing `
                    -TimeoutSec 15 -MaximumRedirection 0 -ErrorAction Stop
                if ([int]$response.StatusCode -eq 200) {
                    $body = ConvertFrom-CheckedJson $response.Content 'Health check'
                    if ((Get-RequiredProperty $body 'status') -ceq 'ok') { return }
                }
            }
            catch { }
            if ($attempt -lt 30) { Start-Sleep -Seconds 10 }
        }
        throw 'HTTPS /healthz did not report status ok within 30 attempts. No deployment metadata was written.'
    }
    finally { [Net.ServicePointManager]::SecurityProtocol = $oldProtocol }
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$stagingDirectory = $null
$demoKey = $null
$mcpKey = $null
$parameters = $null
$credentialData = $null
$result = $null
$credentialsWritten = $false
$locationPushed = $false
$environmentChanged = $false
$savedEnvironment = @{}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'This deployment script requires Windows ACL support.' }
    $git = (Get-Command git -CommandType Application -ErrorAction Stop).Source
    $branch = Invoke-CheckedNative $git @('-C', $repositoryRoot, 'branch', '--show-current') 'Git branch check'
    if ($branch.Trim() -cne 'main') { throw 'Deployment is blocked: the current git branch must be main (not detached HEAD).' }
    $gitRoot = Invoke-CheckedNative $git @('-C', $repositoryRoot, 'rev-parse', '--show-toplevel') 'Git root check'
    if (-not [IO.Path]::GetFullPath($gitRoot.Trim()).TrimEnd('\').Equals(
        $repositoryRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Deployment is blocked: scripts must belong to this repository root.'
    }
    $requiredFiles = @(
        'server\index.ts', 'server\job.ts', 'server\mcp-stdio.ts', 'web\index.html',
        'infra\main.bicep', 'infra\app.bicep', 'Dockerfile'
    )
    $missing = @($requiredFiles | Where-Object {
        -not (Test-Path -LiteralPath (Join-Path $repositoryRoot $_) -PathType Leaf)
    })
    if ($missing.Count -gt 0) {
        throw ('Deployment blocked: required source/template files are missing: ' +
            ($missing -join ', ') + '. No Azure operations were attempted.')
    }

    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $workspace = Resolve-ExternalPath $SecureWorkspacePath $repositoryRoot
    if (-not (Test-Path -LiteralPath $workspace -PathType Container)) {
        throw 'SecureWorkspacePath must already exist as a protected user directory.'
    }
    Assert-PrivateAcl $workspace $userSid
    $credentialsPath = $null
    if ($PSBoundParameters.ContainsKey('CredentialsOutputPath')) {
        if ([string]::IsNullOrWhiteSpace($CredentialsOutputPath)) { throw 'CredentialsOutputPath cannot be empty.' }
        $credentialsPath = Resolve-ExternalPath $CredentialsOutputPath $repositoryRoot
        if ([IO.Path]::GetExtension($credentialsPath) -ine '.json' -or
            (Test-Path -LiteralPath $credentialsPath)) {
            throw 'CredentialsOutputPath must be a fresh .json file; existing paths are never overwritten.'
        }
        $credentialsParent = [IO.Path]::GetDirectoryName($credentialsPath)
        if (-not (Test-Path -LiteralPath $credentialsParent -PathType Container)) {
            throw 'The credentials parent must already exist as a protected user directory.'
        }
        Assert-PrivateAcl $credentialsParent $userSid
    }

    $runtimeDirectory = Join-Path $repositoryRoot '.runtime'
    $metadataPath = Join-Path $runtimeDirectory 'deployment.json'
    Assert-RepositoryMetadataPath $metadataPath $repositoryRoot
    if ((Test-Path -LiteralPath $runtimeDirectory) -and
        -not (Test-Path -LiteralPath $runtimeDirectory -PathType Container)) {
        throw '.runtime must be a directory.'
    }
    if (Test-Path -LiteralPath $metadataPath -PathType Container) { throw 'deployment.json must not be a directory.' }
    $az = (Get-Command az.cmd -CommandType Application -ErrorAction Stop).Source
    Push-Location -LiteralPath $repositoryRoot
    $locationPushed = $true
    # Disable Azure CLI file logging/telemetry without reading or modifying its
    # persisted configuration or authentication files.
    foreach ($name in @('AZURE_LOGGING_ENABLE_LOG_FILE', 'AZURE_CORE_COLLECT_TELEMETRY')) {
        $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, 'false', 'Process')
    }
    $environmentChanged = $true
    foreach ($template in @('infra\main.bicep', 'infra\app.bicep')) {
        $null = Invoke-CheckedNative $az @('bicep', 'build', '--file', $template, '--stdout') 'Bicep compilation'
    }
    $node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
    $npm = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop).Source
    $nodeVersion = Invoke-CheckedNative $node @('--version') 'Node version check'
    if ($nodeVersion.Trim() -notmatch '^v24\.') { throw 'Deployment requires Node.js 24.' }
    Write-Host 'Checking the local build and tests before any Azure writes (run npm ci beforehand).'
    $null = Invoke-CheckedNative $npm @('run', 'build') 'Local application build'
    $null = Invoke-CheckedNative $npm @('test') 'Application tests including built assets'
    $scope = @('--subscription', $SubscriptionId, '--resource-group', $ResourceGroupName,
        '--only-show-errors', '-o', 'json')
    $groupJson = Invoke-CheckedNative $az (@('group', 'show') + $scope) 'Existing resource group lookup'
    $group = ConvertFrom-CheckedJson $groupJson 'Resource group lookup'
    $expectedGroupId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName"
    if ((Get-RequiredProperty $group 'location') -ine 'brazilsouth' -or
        (Get-RequiredProperty $group 'id') -ine $expectedGroupId -or
        (Get-RequiredProperty $group 'name') -ine $ResourceGroupName) {
        throw 'Only the existing rg-education-ai-horizonte in brazilsouth in the requested subscription is allowed.'
    }

    Write-Host 'Deploying phase 1: base infrastructure in the exclusive resource group.'
    $runId = [guid]::NewGuid().ToString('N')
    $mainJson = Invoke-CheckedNative $az (@('deployment', 'group', 'create',
        '--name', "horizonte-base-$runId", '--template-file', 'infra\main.bicep') + $scope) 'Phase 1 deployment'
    $mainDeployment = ConvertFrom-CheckedJson $mainJson 'Phase 1 deployment'
    $baseNames = @(
        'location', 'acrName', 'acrLoginServer', 'environmentName', 'environmentId',
        'environmentDefaultDomain', 'identityName', 'identityId', 'identityClientId',
        'storageAccountName', 'storageBlobEndpoint', 'storageContainerName',
        'openAiAccountName', 'openAiEndpoint', 'openAiDeploymentName', 'openAiApiVersion',
        'appName', 'jobName'
    )
    $base = Get-DeploymentOutputs $mainDeployment $baseNames
    if ($base.location -ine 'brazilsouth' -or
        $base.environmentId -ine "$expectedGroupId/providers/Microsoft.App/managedEnvironments/$($base.environmentName)" -or
        $base.identityId -ine "$expectedGroupId/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$($base.identityName)" -or
        $base.acrName -notmatch '^[a-zA-Z0-9]{5,50}$' -or
        $base.acrLoginServer -ine "$($base.acrName).azurecr.io") {
        throw 'Phase 1 outputs violate the region, resource-group, or registry contract.'
    }
    Write-Host "Waiting $RolePropagationSeconds seconds for role propagation before ACR build."
    Start-Sleep -Seconds $RolePropagationSeconds
    $image = "$($base.acrLoginServer)/horizonte:$ImageTag"
    $null = Invoke-CheckedNative $az (@('acr', 'build', '--registry', $base.acrName,
        '--image', "horizonte:$ImageTag", '--file', 'Dockerfile', '.', '--no-logs') + $scope) 'ACR image build'

    Assert-PrivateAcl $workspace $userSid
    $candidate = Join-Path $workspace ([guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $candidate -ErrorAction Stop
    $stagingDirectory = $candidate
    Set-Acl -LiteralPath $stagingDirectory -AclObject (New-PrivateAcl $userSid -Directory)
    Assert-PrivateAcl $stagingDirectory $userSid
    $parameterPath = Join-Path $stagingDirectory 'app.parameters.json'
    $demoKey = New-RandomKey
    $mcpKey = New-RandomKey
    $appParameters = [ordered]@{}
    foreach ($name in @('location', 'acrName', 'environmentName', 'identityName',
        'storageAccountName', 'storageContainerName', 'openAiAccountName',
        'openAiDeploymentName', 'openAiApiVersion', 'appName', 'jobName')) {
        $appParameters[$name] = @{ value = $base[$name] }
    }
    $appParameters['image'] = @{ value = $image }
    $appParameters['demoAccessKey'] = @{ value = $demoKey }
    $appParameters['mcpAccessKey'] = @{ value = $mcpKey }
    $appParameters['mcpEntraTenantId'] = @{ value = $McpEntraTenantId }
    $appParameters['mcpEntraClientId'] = @{ value = $McpEntraClientId }
    $appParameters['mcpEntraAllowedOids'] = @{ value = $McpEntraAllowedOids }
    $parameters = @{
        '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
        contentVersion = '1.0.0.0'
        parameters = $appParameters
    }
    Write-PrivateJson $parameterPath $parameters $userSid
    if ($null -ne $credentialsPath) {
        $credentialData = [ordered]@{
            SubscriptionId = $SubscriptionId
            ResourceGroupName = $ResourceGroupName
            DeploymentName = "horizonte-app-$runId"
            DemoAccessKey = $demoKey
            McpAccessKey = $mcpKey
        }
        Write-PrivateJson $credentialsPath $credentialData $userSid
        $credentialsWritten = $true
        Write-Host 'Deliberate protected credentials JSON saved; it is retained even if phase 2 fails.'
    }
    Write-Host 'Deploying phase 2: application and job. Native output is suppressed.'
    $appJson = Invoke-CheckedNative $az (@('deployment', 'group', 'create',
        '--name', "horizonte-app-$runId", '--template-file', 'infra\app.bicep',
        '--parameters', "@$parameterPath") + $scope) 'Phase 2 deployment'
    $appDeployment = ConvertFrom-CheckedJson $appJson 'Phase 2 deployment'
    $app = Get-DeploymentOutputs $appDeployment @('appName', 'jobName', 'appUrl', 'appFqdn', 'identityClientId')
    if ($app.appName -cne $base.appName -or $app.jobName -cne $base.jobName -or
        $app.identityClientId -ine $base.identityClientId) {
        throw 'Phase 2 resource names or identity do not match phase 1.'
    }
    $appUri = $null
    if (-not [uri]::TryCreate($app.appUrl, [UriKind]::Absolute, [ref]$appUri) -or
        $appUri.Scheme -cne 'https' -or -not $appUri.IsDefaultPort -or
        $appUri.UserInfo -or $appUri.Query -or $appUri.Fragment -or
        $appUri.AbsolutePath -ne '/' -or $appUri.DnsSafeHost -ine $app.appFqdn -or
        $app.appFqdn -ine "$($base.appName).$($base.environmentDefaultDomain)" -or
        $base.environmentDefaultDomain -notmatch '^[a-zA-Z0-9.-]+\.brazilsouth\.azurecontainerapps\.io$') {
        throw 'Phase 2 must return a nonempty HTTPS app URL and matching Azure Container Apps FQDN.'
    }
    $metadata = [ordered]@{
        subscriptionId = $SubscriptionId
        resourceGroupName = $ResourceGroupName
        image = $image
        deployedAtUtc = [DateTime]::UtcNow.ToString('o')
    }
    foreach ($name in $baseNames) { $metadata[$name] = $base[$name] }
    foreach ($name in $app.Keys) { $metadata[$name] = $app[$name] }
    $metadataJson = ConvertTo-Json -InputObject $metadata -Depth 6
    if ($metadataJson.Contains($demoKey) -or $metadataJson.Contains($mcpKey)) {
        throw 'Unexpected secret in deployment outputs; refusing health checks and metadata persistence.'
    }
    Write-Host 'Waiting for unauthenticated HTTPS /healthz.'
    Wait-AppHealth $appUri
    Assert-RepositoryMetadataPath $metadataPath $repositoryRoot
    if (-not (Test-Path -LiteralPath $runtimeDirectory)) {
        $null = New-Item -ItemType Directory -Path $runtimeDirectory
    }
    $metadataStagingPath = Join-Path $runtimeDirectory ("deployment-$runId.json")
    try {
        [IO.File]::WriteAllText($metadataStagingPath, $metadataJson, (New-Object Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $metadataPath) {
            [IO.File]::Replace($metadataStagingPath, $metadataPath, $null)
        }
        else { [IO.File]::Move($metadataStagingPath, $metadataPath) }
    }
    finally {
        if (Test-Path -LiteralPath $metadataStagingPath) {
            Remove-Item -LiteralPath $metadataStagingPath -Force
        }
    }
    $result = [pscustomobject]@{
        AppUrl = $appUri.AbsoluteUri
        Image = $image
        DeploymentMetadataPath = $metadataPath
        CredentialsOutputPath = $credentialsPath
        DemoAccessKey = ConvertTo-SecureString -String $demoKey -AsPlainText -Force
        McpAccessKey = ConvertTo-SecureString -String $mcpKey -AsPlainText -Force
    }
}
catch {
    if ($credentialsWritten) {
        Write-Warning 'Deployment failed. The deliberately saved protected credentials JSON is retained for recovery/rotation.'
    }
    throw
}
finally {
    $demoKey = $null
    $mcpKey = $null
    $parameters = $null
    $appParameters = $null
    $credentialData = $null
    $appJson = $null
    $appDeployment = $null
    try {
        if ($null -ne $stagingDirectory) {
            Assert-NoReparsePath $stagingDirectory
            Remove-Item -LiteralPath $stagingDirectory -Recurse -Force -ErrorAction Stop
            if (Test-Path -LiteralPath $stagingDirectory) {
                throw 'Secure staging directory remains.'
            }
        }
    }
    catch {
        throw 'Secure staging cleanup failed. Remove the GUID staging directory from SecureWorkspacePath before continuing.'
    }
    finally {
        if ($environmentChanged) {
            foreach ($name in $savedEnvironment.Keys) {
                [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
            }
        }
        if ($locationPushed) { Pop-Location }
    }
}

Write-Host 'Deployment and HTTPS health check succeeded; only nonsecret metadata was persisted.'
$result
