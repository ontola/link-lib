import { BlankNode, NamedNode, Statement } from "rdflib";

import { VocabularyProcessingContext, VocabularyProcessor } from "../types";
import { defaultNS as NS } from "../utilities/constants";

const nsRDFProperty = NS.rdf("Property");
const nsRDFSClass = NS.rdfs("Class");
export const nsRDFSResource = NS.rdfs("Resource");

const nsRDFSsubClassOf = NS.rdfs("subClassOf");
const nsRDFSdomain = NS.rdfs("domain");
const nsRDFSrange = NS.rdfs("range");
const nsRDFSsubPropertyOf = NS.rdfs("subPropertyOf");
const nsRDFtype = NS.rdf("type");

/**
 * Implements the RDF/RDFS axioms and rules.
 * @type {VocabularyProcessor}
 */
export const RDFS = {
    axioms: [
        new Statement(nsRDFtype, nsRDFSdomain, nsRDFSResource),
        new Statement(nsRDFSdomain, nsRDFSdomain, nsRDFProperty),
        new Statement(nsRDFSrange, nsRDFSdomain, nsRDFProperty),
        new Statement(nsRDFSsubPropertyOf, nsRDFSdomain, nsRDFProperty),
        new Statement(nsRDFSsubClassOf, nsRDFSdomain, nsRDFSClass),
        new Statement(NS.rdf("subject"), nsRDFSdomain, NS.rdf("Statement")),
        new Statement(NS.rdf("predicate"), nsRDFSdomain, NS.rdf("Statement")),
        new Statement(NS.rdf("object"), nsRDFSdomain, NS.rdf("Statement")),
        new Statement(NS.rdfs("member"), nsRDFSdomain, nsRDFSResource),
        new Statement(NS.rdf("first"), nsRDFSdomain, NS.rdf("List")),
        new Statement(NS.rdf("rest"), nsRDFSdomain, NS.rdf("List")),
        new Statement(NS.rdfs("seeAlso"), nsRDFSdomain, nsRDFSResource),
        new Statement(NS.rdfs("isDefinedBy"), nsRDFSdomain, nsRDFSResource),
        new Statement(NS.rdfs("comment"), nsRDFSdomain, nsRDFSResource),
        new Statement(NS.rdfs("label"), nsRDFSdomain, nsRDFSResource),
        new Statement(NS.rdf("value"), nsRDFSdomain, nsRDFSResource),

        new Statement(nsRDFtype, nsRDFSrange, nsRDFSClass),
        new Statement(nsRDFSdomain, nsRDFSrange, nsRDFSClass),
        new Statement(nsRDFSrange, nsRDFSrange, nsRDFSClass),
        new Statement(nsRDFSsubPropertyOf, nsRDFSrange, nsRDFProperty),
        new Statement(nsRDFSsubClassOf, nsRDFSrange, nsRDFSClass),
        new Statement(NS.rdf("subject"), nsRDFSrange, nsRDFSResource),
        new Statement(NS.rdf("predicate"), nsRDFSrange, nsRDFSResource),
        new Statement(NS.rdf("object"), nsRDFSrange, nsRDFSResource),
        new Statement(NS.rdfs("member"), nsRDFSrange, nsRDFSResource),
        new Statement(NS.rdf("first"), nsRDFSrange, nsRDFSResource),
        new Statement(NS.rdf("rest"), nsRDFSrange, NS.rdf("List")),
        new Statement(NS.rdfs("seeAlso"), nsRDFSrange, nsRDFSResource),
        new Statement(NS.rdfs("isDefinedBy"), nsRDFSrange, nsRDFSResource),
        new Statement(NS.rdfs("comment"), nsRDFSrange, NS.rdfs("Literal")),
        new Statement(NS.rdfs("label"), nsRDFSrange, NS.rdfs("Literal")),
        new Statement(NS.rdf("value"), nsRDFSrange, nsRDFSResource),

        new Statement(NS.rdf("Alt"), nsRDFSsubClassOf, NS.rdfs("Container")),
        new Statement(NS.rdf("Bag"), nsRDFSsubClassOf, NS.rdfs("Container")),
        new Statement(NS.rdf("Seq"), nsRDFSsubClassOf, NS.rdfs("Container")),
        new Statement(NS.rdfs("ContainerMembershipProperty"), nsRDFSsubClassOf, nsRDFProperty),

        new Statement(NS.rdfs("isDefinedBy"), nsRDFSsubPropertyOf, NS.rdfs("seeAlso")),

        new Statement(NS.rdfs("Datatype"), nsRDFSsubClassOf, nsRDFSClass),

        new Statement(nsRDFSResource, nsRDFtype, nsRDFSClass),
        new Statement(nsRDFSClass, nsRDFtype, nsRDFSClass),
    ],

    processStatement(item: Statement, ctx: VocabularyProcessingContext): Statement[] | null {
        const result = [item];

        const domainStatements = ctx.store.statementsMatching(item.predicate, nsRDFSdomain);
        if (domainStatements.length > 0) {
            for (let i = 0; i < domainStatements.length; i++) {
                result.push(new Statement(item.subject as NamedNode, nsRDFtype, domainStatements[i].object));
            }
        }

        const rangeStatements = ctx.store.statementsMatching(item.predicate, nsRDFSrange);
        if (rangeStatements.length > 0) {                                                     // P rdfs:range C..Cn
            for (let i = 0; i < rangeStatements.length; i++) {
                result.push(new Statement(item.object as NamedNode, nsRDFtype, rangeStatements[i].object));
            }
        }

        if (nsRDFSdomain.equals(item.predicate)) {
            if (!(item.object instanceof NamedNode)) {
                throw new TypeError(`A non IRI was passed as object to rdfs:domain (was: ${item.object}).`);
            }
            result.push(new Statement(item.subject, nsRDFtype, nsRDFProperty));     // P rdf:type rdf:Property
            result.push(new Statement(item.object, nsRDFtype, nsRDFSClass));        // C rdf:type rdfs:Class

            const dereferences = ctx.store.statementsMatching(item.subject);
            for (const { object } of dereferences) {
                result.push(new Statement(item.subject as NamedNode, nsRDFtype, object));
            }
        } else if (nsRDFSrange.equals(item.predicate)) {
            if (!(item.object instanceof NamedNode)) {
                throw new TypeError(`A non IRI was passed as object to rdfs:domain (was: ${item.object}).`);
            }
            result.push(new Statement(item.subject, nsRDFtype, nsRDFProperty));     // P rdf:type rdf:Property
            result.push(new Statement(item.object, nsRDFtype, nsRDFSClass));        // C rdf:type rdfs:Class

            const dereferences = ctx.store.statementsMatching(undefined, undefined, item.subject);
            for (const { subject } of dereferences) {
                result.push(new Statement(subject, nsRDFtype, item.object));
            }
        } else if (nsRDFSsubClassOf.equals(item.predicate)) {                                   // C1 rdfs:subClassOf C2
            if (!(item.object instanceof NamedNode || item.object instanceof BlankNode)) {
                throw new Error("Object of subClassOf statement must be a NamedNode");
            }
            const sSubject = item.subject.value;
            const sObject = item.object.value;
            if (!ctx.superMap.has(sObject)) {
                ctx.superMap.set(sObject, new Set([nsRDFSResource.value]));
            }

            let parents = ctx.superMap.get(sObject);
            if (parents === undefined) {
                parents = new Set();
                ctx.superMap.set(sObject, parents);
            }
            parents.add(item.object.value);
            const itemVal = ctx.superMap.get(sSubject) || new Set<string>([item.subject.value]);

            parents.forEach((i) => itemVal.add(i));

            ctx.superMap.set(sSubject, itemVal);
            ctx.superMap.forEach((v, k) => {
                if (k !== sSubject && v.has(item.subject.value)) {
                    itemVal.forEach(v.add, v);
                }
            });
        } else if (nsRDFSsubPropertyOf.equals(item.predicate)) {
            // TODO: Implement
            return result;
        }

        return result.length === 1 ? null : result;
    },

    processType(type: NamedNode, ctx: VocabularyProcessingContext): boolean {
        RDFS.processStatement(new Statement(type, nsRDFSsubClassOf, nsRDFSResource), ctx);
        ctx.store.add(new Statement(type, nsRDFtype, nsRDFSClass));
        return false;
    },
} as VocabularyProcessor;
