Native Fabric operations
========================

Contract and trust boundaries
-----------------------------

Native Copilot is the primary reasoner. Skills call MCP; the Fabric provider
queries a published Fabric Data Agent backed by the native EducationOntology.
The ontology binds managed Delta tables and native relationships in
HorizonteEducationLakehouse. Only ``ontology\dataset.json`` supplies synthetic
education data. Azure OpenAI educational specialists are a separate provider.
Neither a local JSON graph nor instructions copied into a prompt substitute
for the native ontology. Fabric failures must propagate without fallback.

The runtime adapter does not enforce classroom ownership or replace the MCP
authorization boundary. The integrating caller must authorize users and tools;
Fabric must grant the runtime identity only the permitted underlying data.
Prompt filters are not row-level authorization. Do not deploy multi-user access
to an all-data identity without an independently enforced data-access boundary.

Provisioning
------------

Use Node 24 and the existing dependencies. Select Azure CLI delegated
authentication or a dedicated service principal explicitly. Scripts obtain
short-lived Fabric tokens in memory; they do not read environment files,
token caches, or saved credentials.

::

   node scripts\fabric-provision.mjs
   node scripts\fabric-provision.mjs --apply --capacity CAPACITY_GUID
   node scripts\fabric-provision.mjs --auth service-principal
   node scripts\fabric-provision.mjs --apply --capacity CAPACITY_GUID --auth service-principal

Service-principal mode requires ``FABRIC_TENANT_ID``, ``FABRIC_CLIENT_ID``
and ``FABRIC_CLIENT_SECRET`` injected securely into the process. No secret
is accepted on the command line or stored in the repository. Invalid or
incomplete configuration fails without switching identities. CLI mode can
use ``FABRIC_TENANT_ID`` to choose the intended tenant.

Capacity administrator and tenant API authorization are separate boundaries.
A Fabric administrator must allow the dedicated principal, preferably through
a narrowly scoped security group, in **Service principals can call Fabric
public APIs** and **Service principals can create workspaces, connections,
and deployment pipelines**. Capacity administration alone does not establish
these permissions. A 401 response must not be bypassed by borrowing a different
application's credentials.

The default command is read-only remotely. The apply command uses an existing,
visible, active paid F2-or-greater or P1-or-greater capacity. It never purchases
capacity, resumes capacity, changes tenant settings, assigns an existing
unowned workspace, or modifies another demonstration. PP3 is not P3. The
capacity list is permission-scoped; absence is not proof of tenant-wide absence.

Resource names are ``Horizonte Education``, ``HorizonteEducationLakehouse``,
``HorizonteEducationLoad``, ``EducationOntology``, and ``TeacherEducationAgent``.
Name collisions without the deployment ownership marker fail closed.
``fabric\preflight.json`` records read-only checks without changing deployment
recovery state. ``fabric\deployment.json`` records nonsecret resource IDs, safe
error codes, operation locations and verification state for apply runs.
Apply runs preserve previous IDs and operation URLs and stop when an operation
is unresolved. Inspect the saved operation URL and record its verified terminal
status before repeating a create request. Corrupt state is never overwritten.

The provisioning script creates definitions but deliberately does not execute
the notebook or overwrite existing definitions. Open HorizonteEducationLoad
in the project workspace, verify its attached lakehouse, and run all cells.
It writes only the project's ``horizonte_*`` managed Delta tables. Reexecution
overwrites these synthetic tables; review that operation before rerunning.
Verify row counts against the generated manifest before graph ingestion.
If ontology creation requires populated tables, run the notebook and rerun
provisioning; already-owned items are reused without updates.

Native definitions
------------------

::

   node scripts\fabric-generate.mjs --workspace WORKSPACE_GUID --lakehouse LAKEHOUSE_GUID
   node --test fabric\model.test.mjs
   node --test fabric\provision-state.test.mjs

Generated files are native Fabric item definition envelopes, not an application
graph database. ``EntityTypes`` parts include static Lakehouse column bindings;
``RelationshipTypes`` parts include contextualizations mapping both endpoint
keys to source columns. Missing foreign-key targets remain unmatched, not
invented. Nested arrays and objects are stored as JSON string properties.

The explicit JSON definition selects the generation-1 native format documented
by the current create API. Creating an ontology without a definition instead
selects generation 2. Never apply generation-1 parts to a generation-2 item.
The current generation-2 create example shows TMDL but does not establish the
complete binding grammar. A generation-2 migration requires a validated native
export and is not accomplished by renaming the generated parts.

Native integration acceptance gates
----------------------------------

1. Read the created ontology's generation and export its definition. Verify
   entity keys, every static table/property binding and relationship
   contextualization against the generated manifest and actual Delta tables.
2. Open the associated graph in the Fabric graph editor and save it. Current
   documentation requires this first-open initialization for a REST-created
   graph. Wait for ingestion and check errors; item creation alone is not proof.
3. Use the graph editor's actual schema to execute a traversal across
   Teacher, Classroom, Lesson, Curriculum, Activity, Evidence and Intervention.
   Relationships in this definition point from child to referenced parent;
   traverse reverse directions where appropriate. Save the actual GQL,
   returned synthetic IDs, row counts, query timestamp and graph ID as evidence.
   Do not report an expected path as an executed query.
4. Open TeacherEducationAgent, choose Add a data source, and select the
   EducationOntology item itself. Selecting a Lakehouse or Graph instead is not
   equivalent. Confirm the ontology and its entity types in the source explorer.
   Publish the agent. Preserve native source-selection evidence and any error
   code. An ``OntologyAddAsDataSourceBlocked`` response is a blocker, not a cue
   to substitute a different source.
5. Query the published MCP endpoint. Request the same teacher/class/lesson
   path and corroborate the returned IDs and source/query trace against step 3.
   MCP success without native source and traversal evidence is insufficient.

The public Data Agent datasource schema currently omits ``ontology`` although
the portal's native ontology source is documented. This implementation does not
invent a REST payload or use private workload APIs. The documented Python SDK
provides ``add_staging_datasource`` and ``publish_staging``, but its public
example does not establish ontology attachment. Portal selection remains the
documented attachment procedure until that contract is verified.

Runtime adapter
---------------

``server\fabric.ts`` exports ``createFabricClient(config, deps?)``.
Configuration requires ``workspaceId``, ``dataAgentId``, ``ontologyId`` and
``auth`` (``azure-cli`` or ``token-provider``). An injected token provider
receives ``https://api.fabric.microsoft.com/.default`` and an AbortSignal.
Use a delegated user or supported service principal, not a managed identity
for Data Agent runtime. Management identity support is a separate contract.

``client.query(question, { signal }?)`` returns provider/source ``fabric``,
resource IDs, endpoint, discovered tool, text content, answer and optional
structured content. ``client.health()`` reports only the last observed
availability. ``FabricError.code`` exposes sanitized failures. Neither method
claims verified native ontology integration: ``nativeOntology.status`` remains
``unverified``. Operator attestation is separately recorded, never transformed
into runtime proof.

The client discovers tools and validates a single-string question schema.
An unannotated tool requires explicit ``tool.name``, ``tool.inputProperty``
and ``tool.readOnlyAttested`` after inspection. Ambiguity, unsupported schemas,
authentication, network, tool errors and deadlines fail explicitly. The native
MCP endpoint is fixed to the official Fabric host, without redirects:

::

   https://api.fabric.microsoft.com/v1/mcp/workspaces/WORKSPACE_GUID/dataagents/AGENT_GUID/agent

Integration into existing MCP handlers is intentionally separate. Do not treat
the existence of this adapter as proof that those handlers use it.

Validation
----------

::

   npx tsx --test test\fabric.test.ts
   node --test fabric\model.test.mjs
   npm test
   npm run build

Mock tests prove local behavior only. Native runtime acceptance requires all
five gates above on the deployed resources.

Official contracts
------------------

* `Create ontology and generation selection <https://learn.microsoft.com/en-us/rest/api/fabric/ontology/items/create-ontology>`_
* `Native entity and relationship definition <https://learn.microsoft.com/en-us/rest/api/fabric/articles/item-management/definitions/ontology-definition>`_
* `Lakehouse bindings and limitations <https://learn.microsoft.com/en-us/fabric/iq/ontology/how-to-bind-data>`_
* `Graph initialization and refresh <https://learn.microsoft.com/en-us/fabric/graph/manage-data>`_
* `Graph executeQuery beta <https://learn.microsoft.com/en-us/rest/api/fabric/graphmodel/items/execute-query%28beta%29>`_
* `Add ontology to Data Agent <https://learn.microsoft.com/en-us/fabric/iq/ontology/tutorial-4-create-data-agent>`_
* `Data Agent definition <https://learn.microsoft.com/en-us/rest/api/fabric/articles/item-management/definitions/data-agent-definition>`_
* `Data Agent SDK <https://learn.microsoft.com/en-us/fabric/data-science/fabric-data-agent-sdk>`_
* `Published MCP endpoint <https://learn.microsoft.com/en-us/fabric/data-science/data-agent-mcp-server>`_
* `Runtime identity restrictions <https://learn.microsoft.com/en-us/fabric/data-science/data-agent-service-principal>`_
* `Tenant settings <https://learn.microsoft.com/en-us/fabric/data-science/data-agent-tenant-settings>`_
* `Service-principal tenant authorization <https://learn.microsoft.com/en-us/fabric/admin/service-admin-portal-developer>`_
* `Create workspace <https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/create-workspace>`_
* `Run notebook item job <https://learn.microsoft.com/en-us/rest/api/fabric/core/job-scheduler/run-on-demand-item-job>`_
