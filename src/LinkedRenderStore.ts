import {
    FetchOpts as RDFFetchOpts,
    NamedNode,
    Quadruple,
    SomeTerm,
    Statement,
} from "rdflib";

import { ComponentStore } from "./ComponentStore";
import { LinkedDataAPI } from "./LinkedDataAPI";
import { ProcessBroadcast } from "./ProcessBroadcast";
import { DataProcessor, emptyRequest } from "./processor/DataProcessor";
import { dataToGraphTuple } from "./processor/DataToGraph";
import { RDFStore } from "./RDFStore";
import { Schema } from "./Schema";
import {
    ActionMap,
    ComponentRegistration,
    DataObject,
    DeltaProcessor,
    Dispatcher,
    EmptyRequestStatus,
    ErrorReporter,
    FetchOpts,
    FulfilledRequestStatus,
    LazyNNArgument,
    LinkedActionResponse,
    LinkedRenderStoreOptions,
    MiddlewareActionHandler,
    NamespaceMap,
    ResourceQueueItem,
    SomeNode,
    SubscriptionRegistrationBase,
} from "./types";
import { normalizeType } from "./utilities";
import { DEFAULT_TOPOLOGY, defaultNS, RENDER_CLASS_NAME } from "./utilities/constants";
import { expandProperty } from "./utilities/memoizedNamespace";

/**
 * Main entrypoint into the functionality of link-lib.
 *
 * Before using the methods for querying data and views here, search through your render library (e.g. link-redux) to
 * see if it exposes an API which covers your use-case. Skipping the render library might cause unexpected behaviour and
 * hard to solve bugs.
 */
export class LinkedRenderStore<T> implements Dispatcher {
    public static registerRenderer<T>(
        component: T,
        type: LazyNNArgument,
        prop: LazyNNArgument = RENDER_CLASS_NAME,
        topology: LazyNNArgument | Array<NamedNode | undefined> = DEFAULT_TOPOLOGY): Array<ComponentRegistration<T>> {

        const types = normalizeType(type).map((n) => n.sI);
        const props = normalizeType(prop)
            .map((p) => (p || RENDER_CLASS_NAME).sI);
        const topologies = normalizeType(topology)
            .map((t) => (t || DEFAULT_TOPOLOGY).sI);

        return ComponentStore.registerRenderer(component, types, props, topologies);
    }

    /**
     * Map of {ActionMap} which hold action dispatchers. Calling a dispatcher should execute the action, causing them to
     * be handled like any back-end sent action.
     *
     * Constructing action IRI's and dispatching them in user code was a bit hard, this object allows any middleware to
     * define their actions (within their namespace) in a code-oriented fashion. The middleware has control over how the
     * actions will be dispatched, but it should be the same as if a back-end would have executed the action (via the
     * Exec-Action header).
     */
    public actions: { [k: string]: ActionMap } = {};
    /** Whenever a resource has no type, assume it to be this. */
    public defaultType: NamedNode = defaultNS.schema("Thing");
    public deltaProcessors: DeltaProcessor[];
    public report: ErrorReporter;
    public namespaces: NamespaceMap = {...defaultNS};

    public api: LinkedDataAPI;
    public mapping: ComponentStore<T>;
    public schema: Schema;
    public store: RDFStore = new RDFStore();

    private _dispatch?: MiddlewareActionHandler;
    private bulkFetch: boolean = false;
    private cleanupTimer: number | undefined;
    private currentBroadcast: Promise<void> | undefined;
    private broadcastHandle: number | undefined;
    private bulkSubscriptions: Array<SubscriptionRegistrationBase<unknown>> = [];
    private subjectSubscriptions: Array<Array<SubscriptionRegistrationBase<unknown>>> = [];
    private lastPostponed: number | undefined;
    private resourceQueue: ResourceQueueItem[];
    private resourceQueueHandle: number | undefined;

    // tslint:disable-next-line no-object-literal-type-assertion
    public constructor(opts: LinkedRenderStoreOptions<T> = {}) {
        if (opts.store) {
            this.store = opts.store;
        }

        this.report = opts.report || ((e): void => { throw e; });
        this.api = opts.api || new DataProcessor({
            dispatch: opts.dispatch,
            report: this.report,
            store: this.store,
        });
        this.deltaProcessors = [this.api, this.store];
        if (opts.dispatch) {
            this.dispatch = opts.dispatch;
        }
        this.defaultType = opts.defaultType || defaultNS.schema("Thing");
        this.namespaces = opts.namespaces || {...defaultNS};
        this.schema = opts.schema || new Schema(this.store);
        this.mapping = opts.mapping || new ComponentStore(this.schema);
        this.resourceQueue = [];

        this.broadcast = this.broadcast.bind(this);
        this.processResourceQueue = this.processResourceQueue.bind(this);
    }

    public get dispatch(): MiddlewareActionHandler {
        if (typeof this._dispatch === "undefined") {
            throw new Error("Invariant: cannot call `dispatch` before initialization is complete");
        }

        return this._dispatch;
    }

    public set dispatch(value: MiddlewareActionHandler) {
        this._dispatch = value;
        this.api.dispatch = value;
    }

    /**
     * Push one or more ontological items onto the graph so it can be used by the render store for component
     * determination.
     *
     * Adding information after the initial render currently conflicts with the caching and will result in inconsistent
     * results.
     *
     * Statements added here will also be added to the data store so views can access the statements.
     */
    public addOntologySchematics(items: Statement[]): void {
        this.schema.addStatements(items);
    }

    /**
     * Execute an Action by its IRI. This will result in an HTTP request being done and probably some state changes.
     * @param {module:rdflib.NamedNode} subject The resource to execute. Generally a schema:Action derivative with a
     *   schema:EntryPoint to describe the request. Currently schema:url is used over schema:urlTemplate
     *   to acquire the request URL, since template processing isn't implemented (yet).
     * @param {DataObject} data An object to send in the body when a non-safe method is used.
     * @return {Promise<LinkedActionResponse>}
     */
    public execActionByIRI(subject: NamedNode, data?: DataObject): Promise<LinkedActionResponse> {
        const preparedData = dataToGraphTuple(data || {});
        return this
            .api
            .execActionByIRI(subject, preparedData)
            .then((res: LinkedActionResponse) => {
                this.broadcast(false, 100);
                return res;
            });
    }

    /**
     * Execute a resource.
     *
     * Every action will fall through the execution middleware layers.
     *
     * @see https://github.com/fletcher91/link-lib/wiki/%5BDesign-draft%5D-Actions,-data-streams,-and-middleware
     *
     * @param {NamedNode} subject The resource to execute (can be either an IRI or an URI)
     * @param {Object} args The arguments to the function defined by the subject.
     */
    public async exec(subject: NamedNode, args?: DataObject): Promise<any> {
        return this.dispatch(subject, args);
    }

    /**
     * Convert a string value to a NamedNode if possible. Useful for looking op dynamic data like user input. Please
     * refrain from using in static code, as this will impact performance.
     */
    public expandProperty(prop: NamedNode | string | undefined): NamedNode | undefined {
        return expandProperty(prop, this.namespaces);
    }

    /**
     * Resolve the values at the end of the path
     * @param subject The resource to start descending on
     * @param path A list of linked predicates to descend on.
     */
    public dig(subject: SomeNode, path: NamedNode[]): SomeTerm[] {
        if (path.length === 0) {
            return [];
        }

        const remaining = path.slice();
        const pred = remaining.shift();

        if (remaining.length === 0) {
            return this.getResourceProperties(subject, pred!);
        }

        const props = this.getResourceProperties(subject, pred!);
        if (props) {
            return props
                .map((term) => (term.termType === "NamedNode" || term.termType === "BlankNode")
                    && this.dig(term, remaining))
                .flat(1)
                .filter(Boolean);
        }

        return [];
    }

    /**
     * Retrieve the subjects from {subject} to find all resources which have an object at the
     * end of the {path} which matches {match}.
     * @param subject The resource to start descending on.
     * @param path A list of linked predicates to descend on.
     * @param match The value which the predicate at the end of {path} has to match for its subject to return.
     */
    public findSubject(subject: SomeNode, path: NamedNode[], match: SomeTerm | SomeTerm[]): SomeNode[] {
        if (path.length === 0) {
            return [];
        }

        const remaining = path.slice();
        const pred = remaining.shift();
        const props = this.getResourceProperties(subject, pred!);

        if (props && remaining.length === 0) {
            const finder = Array.isArray(match)
                ? (p: SomeTerm): boolean => match.some((m) => m.equals(p))
                : (p: SomeTerm): boolean => match.equals(p);

            return props.find(finder) ? [subject] : [];
        } else if (props) {
            return props
                .map((term) => (term.termType === "NamedNode" || term.termType === "BlankNode")
                    && this.findSubject(term, remaining, match))
                .flat(1)
                .filter(Boolean);
        }

        return [];
    }

    /**
     * Finds the best render component for a given property in respect to a topology.
     *
     * @renderlibrary This should only be used by render-libraries, not by application code.
     * @param type The type(s) of the resource to render.
     * @param predicate The predicate(s) (property(s)) to render.
     * @param [topology] The topology of the resource, if any
     * @returns The most appropriate renderer, if any.
     */
    public getComponentForProperty(type: NamedNode | NamedNode[] | undefined = this.defaultType,
                                   predicate: NamedNode | NamedNode[],
                                   topology: NamedNode = DEFAULT_TOPOLOGY): T | undefined {
        if (type === undefined || (Array.isArray(type) && type.length === 0)) {
            return undefined;
        }
        const types = normalizeType(type).map((n) => n.sI);
        const predicates = normalizeType(predicate).map((n) => n.sI);

        return this.mapping.getRenderComponent(types, predicates, topology.sI, this.defaultType.sI);
    }

    /**
     * Finds the best render component for a type in respect to a topology.
     *
     * @renderlibrary This should only be used by render-libraries, not by application code.
     * @see LinkedRenderStore#getComponentForProperty
     * @param type The type(s) of the resource to render.
     * @param [topology] The topology of the resource, if any
     * @returns The most appropriate renderer, if any.
     */
    public getComponentForType(type: NamedNode | NamedNode[], topology: NamedNode = DEFAULT_TOPOLOGY): T | undefined {
        return this.getComponentForProperty(type, RENDER_CLASS_NAME, topology);
    }

    /**
     * Efficiently queues a resource to be fetched later.
     *
     * This skips the overhead of creating a promise and allows the subsystem to retrieve multiple resource in one
     * round trip, sacrificing loading status for performance.
     * @renderlibrary This should only be used by render-libraries, not by application code.
     */
    public queueEntity(iri: NamedNode, opts?: FetchOpts): void {
        if (!(opts && opts.reload) && !this.shouldLoadResource(iri)) {
            return;
        }

        this.resourceQueue.push([iri, opts]);
        this.scheduleResourceQueue();
    }

    /**
     * Queue a linked-delta to be processed.
     *
     * Note: This should only be used by render-libraries (e.g. link-redux), not by application code.
     * @renderlibrary This should only be used by render-libraries, not by application code.
     */
    public queueDelta(delta: Array<Quadruple|void> | Statement[], expedite = false): Promise<void> {
        const quadArr = delta[0] instanceof Statement
            ? (delta as Statement[]).map((s: Statement) => s.toQuad())
            : delta as Quadruple[];
        const subjects = quadArr.reduce((acc, [s]) => acc.includes(s.sI) ? acc : acc.concat(s.sI), [] as number[]);

        for (const dp of this.deltaProcessors) {
            dp.queueDelta(quadArr, subjects);
        }

        return this.broadcastWithExpedite(expedite);
    }

    /**
     * Will fetch the entity with the URL {iri}. When a resource under that subject is already present, it will not
     * be fetched again.
     *
     * @renderlibrary This should only be used by render-libraries, not by application code.
     * @param iri The SomeNode of the resource
     * @param opts The options for fetch-/processing the resource.
     * @return A promise with the resulting entity
     */
    public async getEntity(iri: NamedNode, opts?: FetchOpts): Promise<void> {
        const apiOpts: RDFFetchOpts = {};
        let preExistingData;
        if (opts && opts.reload) {
            apiOpts.force = true;
            apiOpts.clearPreviousData = true;
            preExistingData = this.tryEntity(iri);
        }
        if (preExistingData !== undefined) {
            this.store.removeStatements(preExistingData);
        }
        await this.api.getEntity(iri, apiOpts);
        this.broadcast();
    }

    /**
     * Resolves all the properties {property} of resource {subject} to their statements.
     *
     * @renderlibrary This should only be used by render-libraries, not by application code.
     * @param {SomeNode} subject The resource to get the properties for.
     * @param {SomeNode | SomeNode[]} property
     * @return {Statement[]} All the statements of {property} on {subject}, or an empty array when none are present.
     */
    public getResourcePropertyRaw(subject: SomeNode, property: SomeNode | SomeNode[]): Statement[] {
        return this.store.getResourcePropertyRaw(subject, property);
    }

    /**
     * Resolves all the properties {property} of resource {subject} to a value.
     *
     * @renderlibrary This should only be used by render-libraries, not by application code.
     * @param {SomeNode} subject The resource to get the properties for.
     * @param {SomeNode | SomeNode[]} property
     * @return {SomeTerm[]} The resolved values of {property}, or an empty array when none are present.
     */
    public getResourceProperties(subject: SomeNode, property: SomeNode | SomeNode[]): SomeTerm[] {
        return this.store.getResourceProperties(subject, property);
    }

    /**
     * Resolves the property {property} of resource {subject} to a value.
     *
     * When more than one statement on {property} is present, a random one will be chosen. See
     * {LinkedResourceContainer#getResourceProperties} to retrieve all the values.
     *
     * @renderlibrary This should only be used by render-libraries, not by application code.
     * @param {SomeNode} subject The resource to get the properties for.
     * @param {SomeNode | SomeNode[]} property
     * @return {SomeTerm | undefined} The resolved value of {property}, or undefined when none are present.
     */
    public getResourceProperty(subject: SomeNode, property: SomeNode | SomeNode[]): SomeTerm | undefined {
        return this.store.getResourceProperty(subject, property);
    }

    /**
     * Retrieve the (network) status of the resource {iri}.
     *
     * Status 202 indicates that the resource has been queued for fetching (subject to change).
     */
    public getStatus(iri: SomeNode): EmptyRequestStatus | FulfilledRequestStatus {
        if (iri.termType === "BlankNode") {
            return emptyRequest as EmptyRequestStatus;
        }

        if (this.resourceQueue.find(([resource]) => resource === iri)) {
            return {
                lastRequested: new Date(),
                lastResponseHeaders: null,
                requested: true,
                status: 202,
                timesRequested: 1,
            };
        }

        return this.api.getStatus(iri);
    }

    /**
     * Process a linked-delta onto the store.
     *
     * This should generally only be called from the middleware or the data api
     * @param delta An array of [s, p, o, g] arrays containing the delta.
     * @param expedite Will immediately process the delta rather than waiting for an idle moment, useful in conjunction
     *  with event handlers within the UI needing immediate feedback. Might cause jumpy interfaces.
     */
    public processDelta(delta: Array<Quadruple|void> | Statement[], expedite = false): Promise<Statement[]> {
        const quadArr = delta[0] instanceof Statement
            ? (delta as Statement[]).map((s: Statement) => s.toQuad())
            : delta as Quadruple[];
        const statements = this.deltaProcessors
            .reduce((acc: Statement[], dp: DeltaProcessor) => acc.concat(dp.processDelta(quadArr)), []);

        return this.broadcastWithExpedite(expedite)
            .then(() => statements);
    }

    /**
     * Bulk register components formatted with {LinkedRenderStore.registerRenderer}.
     * @see LinkedRenderStore.registerRenderer
     */
    public registerAll(...components: Array<ComponentRegistration<T> | Array<ComponentRegistration<T>>>): void {
        const registerItem = (i: ComponentRegistration<T>): void => {
            this.mapping.registerRenderer(i.component, i.type, i.property, i.topology);
        };
        for (let i = 0; i < components.length; i++) {
            if (Array.isArray(components[i])) {
                for (let j = 0; j < (components[i] as Array<ComponentRegistration<T>>).length; j++) {
                    registerItem((components[i] as Array<ComponentRegistration<T>>)[j]);
                }
            } else {
                registerItem(components[i] as ComponentRegistration<T>);
            }
        }
    }

    /**
     * Remove a resource from the store, when views are still rendered the resource will be re-fetched.
     *
     * @unstable
     */
    public removeResource(subject: SomeNode, expedite = false): Promise<void> {
        this.api.invalidate(subject);
        this.store.removeResource(subject);

        return this.broadcastWithExpedite(expedite);
    }

    /**
     * Resets the render store mappings and the schema graph.
     *
     * Note: This should only be used by render-libraries (e.g. link-redux), not by application code.
     */
    public reset(): void {
        this.store = new RDFStore();
        this.schema = new Schema(this.store);
        this.mapping = new ComponentStore(this.schema);
    }

    /**
     * Get a render component for a rendering {property} on resource {subject}.
     *
     * @renderlibrary
     * @param {SomeNode} subject
     * @param {NamedNode | NamedNode[]} predicate
     * @param {NamedNode} topology
     * @return {T | undefined}
     */
    public resourcePropertyComponent(subject: SomeNode,
                                     predicate: NamedNode | NamedNode[],
                                     topology?: NamedNode): T | undefined {
        return this.getComponentForProperty(
            this.store.getResourceProperties(subject, defaultNS.rdf("type")) as NamedNode[],
            predicate,
            topology || DEFAULT_TOPOLOGY,
        );
    }

    /**
     * Get a render component for {subject}.
     *
     * @renderlibrary
     * @param {SomeNode} subject The resource to get the renderer for.
     * @param {"rdflib".NamedNode} topology The topology to take into account when picking the renderer.
     * @return {T | undefined}
     */
    public resourceComponent(subject: SomeNode, topology?: NamedNode): T | undefined {
        return this.getComponentForProperty(
            this.store.getResourceProperties(subject, defaultNS.rdf("type")) as NamedNode[],
            RENDER_CLASS_NAME,
            topology || DEFAULT_TOPOLOGY,
        );
    }

    /**
     * Determine if it makes sense to load a resource.
     *
     * @renderlibrary
     * @unstable
     */
    public shouldLoadResource(subject: SomeNode): boolean {
        return (this.store.changeTimestamps[subject.sI] === 0 || this.api.isInvalid(subject))
            && !this.resourceQueue.find(([i]) => i === subject);
    }

    /**
     * Listen for data changes by subscribing to store changes.
     *
     * @renderlibrary This should only be used by render-libraries, not by application code.
     * @param registration
     * @param registration[0] Will be called with the new statements as its argument.
     * @param registration[1] Options for the callback.
     * @param registration[1].onlySubjects Only the subjects are passed when true.
     * @return function Unsubscription function.
     */
    public subscribe(registration: SubscriptionRegistrationBase<unknown>): () => void {
        registration.subscribedAt = Date.now();
        const subjectFilter = registration.subjectFilter;

        if (typeof subjectFilter !== "undefined" && subjectFilter.length > 0) {
            for (let i = 0, len = subjectFilter.length; i < len; i++) {
                if (!this.subjectSubscriptions[subjectFilter[i].sI]) {
                    this.subjectSubscriptions[subjectFilter[i].sI] = [];
                }
                this.subjectSubscriptions[subjectFilter[i].sI].push(registration);
            }

            return (): void => {
                registration.markedForDelete = true;
                this.markForCleanup();
            };
        }

        this.bulkSubscriptions.push(registration);

        return (): void => {
            this.bulkSubscriptions.splice(this.bulkSubscriptions.indexOf(registration), 1);
        };
    }

    /** @internal */
    public touch(_iri: string | NamedNode, _err?: Error): boolean {
        this.broadcast();
        return true;
    }

    /**
     * Returns an entity from the cache directly.
     * This won't cause any network requests even if the entity can't be found.
     *
     * @renderlibrary This should only be used by render-libraries, not by application code.
     * @param iri The SomeNode of the resource.
     * @returns The object if found, or undefined.
     */
    public tryEntity(iri: SomeNode): Statement[] {
        return this.store.statementsFor(iri);
    }

    /**
     * Broadcasts buffered to all subscribers.
     * The actual broadcast might be executed asynchronously to prevent lag.
     *
     * @param buffer Controls whether processing can be delayed until enough is available.
     * @param maxTimeout Set to 0 to execute immediately.
     * Note: This should only be used by render-libraries (e.g. link-redux), not by application code.
     */
    private broadcast(buffer = true, maxTimeout = 1000): Promise<void> {
        if (maxTimeout !== 0 && this.currentBroadcast || this.broadcastHandle) {
            return this.currentBroadcast || Promise.resolve();
        }

        if (buffer) {
            if (this.store.workAvailable() >= 2) {
                if (this.broadcastHandle) {
                    window.clearTimeout(this.broadcastHandle);
                }
                if (this.lastPostponed === undefined) {
                    this.lastPostponed = Date.now();
                    this.broadcastHandle = window.setTimeout(() => {
                        this.broadcastHandle = undefined;
                        this.broadcast(buffer, maxTimeout);
                    }, 200);

                    return this.currentBroadcast || Promise.resolve();
                } else if (Date.now() - this.lastPostponed <= maxTimeout) {
                    this.broadcastHandle = window.setTimeout(() => {
                        this.broadcastHandle = undefined;
                        this.broadcast(buffer, maxTimeout);
                    }, 200);

                    return this.currentBroadcast || Promise.resolve();
                }
            }
            this.lastPostponed = undefined;
            this.broadcastHandle = undefined;
        }
        if (this.store.workAvailable() === 0) {
            return Promise.resolve();
        }

        const work = this.deltaProcessors.flatMap((dp) => dp.flush());
        const subjects = work
            .reduce((acc, w) => acc.includes(w.subject.sI) ? acc : acc.concat(w.subject.sI), [] as number[]);
        const subjectRegs = subjects
            .flatMap((sI) => this.subjectSubscriptions[sI])
            .filter((reg) => reg
                && !reg.markedForDelete
                && (reg.subjectFilter
                    ? reg.subjectFilter.some((s) => subjects.includes(s.sI))
                    : true));

        if (this.bulkSubscriptions.length === 0 && subjectRegs.length === 0) {
            return Promise.resolve();
        }

        return this.currentBroadcast = new ProcessBroadcast({
            bulkSubscriptions: this.bulkSubscriptions.slice(),
            changedSubjects: subjects,
            subjectSubscriptions: subjectRegs,
            timeout: maxTimeout,
            work,
        }).run()
          .then(() => {
              this.currentBroadcast = undefined;
              if (this.store.workAvailable() > 0) {
                  this.broadcast();
              }
          });
    }

    private broadcastWithExpedite(expedite: boolean): Promise<void> {
        return this.broadcast(!expedite, expedite ? 0 : 500);
    }

    private markForCleanup(): void {
        if (this.cleanupTimer) {
            return;
        }

        this.cleanupTimer = window.setTimeout(() => {
            this.cleanupTimer = undefined;
            this.subjectSubscriptions.forEach((registrations) => {
                for (let i = 0; i < registrations.length; i++) {
                    if (registrations[i].markedForDelete) {
                        registrations.splice(i, 1);
                    }
                    if (registrations.length === 0) {
                        delete registrations[i];
                    }
                }
            });
        }, 500);
    }

    private scheduleResourceQueue(): void {
        if (this.resourceQueueHandle) {
            return;
        }

        if (typeof window.requestIdleCallback !== "undefined") {
            this.resourceQueueHandle = window.requestIdleCallback(this.processResourceQueue, { timeout: 100 });
        } else {
            this.resourceQueueHandle = window.setTimeout(this.processResourceQueue, 100);
        }
    }

    private processResourceQueue(): void {
        this.resourceQueueHandle = undefined;
        const queue = this.resourceQueue;
        this.resourceQueue = [];

        if (this.bulkFetch) {
            this.api
                .getEntities(queue)
                .then(() => this.broadcast());
        } else {
            for (let i = 0; i < queue.length; i++) {
                try {
                    const [iri, opts] = queue[i];
                    this.getEntity(iri, opts);
                } catch (e) {
                    this.report(e);
                }
            }
        }
    }
}
