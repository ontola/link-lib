import "jest";
import {
    IndexedFormula,
    Literal,
    NamedNode,
    Quadruple,
    Statement,
} from "rdflib";

import { RDFStore } from "../RDFStore";
import { getBasicStore } from "../testUtilities";
import { defaultNS as NS } from "../utilities/constants";

const schemaT = NS.schema("Thing");
const thingStatements = [
    new Statement(schemaT, NS.rdf("type"), NS.rdfs("Class"), NS.example("why")),
    new Statement(schemaT, NS.rdfs("comment"), new Literal("The most generic type of item."), NS.example("why")),
    new Statement(schemaT, NS.rdfs("label"), new Literal("Thing."), NS.example("why")),
];

describe("RDFStore", () => {
    describe("#addStatements", () => {
        it("requires an array", () => {
            const store = new RDFStore();

            expect(() => {
                store.addStatements("test" as any);
            }).toThrowError(TypeError);
        });

        it("works", () => {
            const store = new RDFStore();
            store.addStatements(thingStatements);

            const libStatements = store.getInternalStore().statements;
            expect(libStatements).toHaveLength(3);
            expect(libStatements[0]).toEqual(thingStatements[0]);
            expect(libStatements[1]).toEqual(thingStatements[1]);
            expect(libStatements[2]).toEqual(thingStatements[2]);
        });
    });

    describe("#flush", () => {
        it("is returns the work available", () => {
            const store = new RDFStore();
            store.addStatements(thingStatements);
            const res = store.flush();
            expect(res[0]).toEqual(thingStatements[0]);
            expect(res[1]).toEqual(thingStatements[1]);
            expect(res[2]).toEqual(thingStatements[2]);
        });

        it("is returns a frozen empty array without work", () => {
            const res = new RDFStore().flush();
            expect(res.length).toEqual(0);
            expect(Object.isFrozen(res)).toBeTruthy();
        });
    });

    describe("#getInternalStore", () => {
        it("returns the store", () => {
            expect(new RDFStore().getInternalStore())
                .toBeInstanceOf(IndexedFormula);
        });
    });

    describe("#replaceMatches", () => {
        it("replaces a statement", () => {
            const store = new RDFStore();
            store.addStatements(thingStatements);

            const quads: Quadruple[] = [
                [schemaT, NS.rdfs("label"), new Literal("Thing!"), NS.ll("replace")],
            ];

            const before = store.match(schemaT, NS.rdfs("label"));
            expect(before).toHaveLength(1);
            expect(before[0].object).toEqual(new Literal("Thing."));

            store.replaceMatches(quads);

            const after = store.match(schemaT, NS.rdfs("label"));
            expect(after).toHaveLength(1);
            expect(after[0].object).toEqual(new Literal("Thing!", undefined, NS.xsd("string")));
        });
    });

    describe("#processDelta", () => {
        it("handles empty values", () => {
            const store = new RDFStore();

            expect(store.processDelta(new Array(1))).toEqual([]);
        });

        describe("ll:replace", () => {
            it("replaces existing", () => {
                const store = new RDFStore();

                expect(store.processDelta(new Array(1))).toEqual([]);
            });
        });

        describe("ll:remove", () => {
            it("removes one", () => {
                const store = new RDFStore();
                store.addStatements(thingStatements);

                expect(store.match(null)).toHaveLength(thingStatements.length);

                const statements: Quadruple[] = [
                    [schemaT, NS.rdfs("label"), new Literal("irrelevant"), NS.ll("remove")],
                ];

                store.processDelta(statements);

                expect(store.match(null)).toHaveLength(thingStatements.length - 1);
                expect(store.match(schemaT, NS.rdfs("label"))).toHaveLength(0);
            });

            it("removes many", () => {
                const store = new RDFStore();
                store.addStatements(thingStatements);
                store.addStatements([new Statement(schemaT, NS.rdfs("label"), new Literal("Thing gb", "en-gb"))]);

                expect(store.match(null)).toHaveLength(thingStatements.length + 1);

                const quads: Quadruple[] = [
                    [schemaT, NS.rdfs("label"), new Literal("irrelevant"), NS.ll("remove")],
                ];

                store.processDelta(quads);

                expect(store.match(null)).toHaveLength(thingStatements.length - 1);
                expect(store.match(schemaT, NS.rdfs("label"))).toHaveLength(0);
            });
        });
    });

    describe("#replaceStatements", () => {
        it("replaces statements", () => {
            const old = [new Statement(NS.ex("a"), NS.ex("p"), NS.ex("x"))];
            const next = [new Statement(NS.ex("a"), NS.ex("q"), NS.ex("x"))];
            const store = new RDFStore();
            store.addStatements(old);
            store.replaceStatements(old, next);

            expect(store.match(null, null, null, null)).toHaveLength(1);
            expect(store.match(NS.ex("a"))[0]).toEqual(next[0]);
        });
    });

    describe("#getResourcePropertyRaw", () => {
        const store = new RDFStore();
        store.addStatements([
            new Statement(NS.ex("a"), NS.ex("p"), NS.ex("x")),
            new Statement(NS.ex("a"), NS.ex("r"), NS.ex("y")),

            new Statement(NS.ex("b"), NS.ex("p"), NS.ex("xx")),
            new Statement(NS.ex("b"), NS.ex("p"), NS.ex("yy")),
        ]);

        it("resolves empty values for single property", () => {
            expect(store.getResourcePropertyRaw(NS.ex("none"), NS.ex("p")))
                .toEqual([]);
        });

        it("resolves empty values for multiple properties", () => {
            expect(store.getResourcePropertyRaw(NS.ex("none"), [NS.ex("p"), NS.ex("q")]))
                .toEqual([]);
        });

        it("resolves values for single property", () => {
            expect(store.getResourcePropertyRaw(NS.ex("b"), NS.ex("p")))
                .toEqual([
                    new Statement(NS.ex("b"), NS.ex("p"), NS.ex("xx"), new NamedNode("chrome:theSession")),
                    new Statement(NS.ex("b"), NS.ex("p"), NS.ex("yy"), new NamedNode("chrome:theSession")),
                ]);
        });

        it("resolves value for multiple properties one existent", () => {
            expect(store.getResourcePropertyRaw(NS.ex("a"), [NS.ex("p"), NS.ex("q")]))
                .toEqual([
                    new Statement(NS.ex("a"), NS.ex("p"), NS.ex("x"), new NamedNode("chrome:theSession")),
                ]);
        });

        it("resolves value for multiple properties multiple existent", () => {
            expect(store.getResourcePropertyRaw(NS.ex("a"), [NS.ex("r"), NS.ex("p")]))
                .toEqual([
                    new Statement(NS.ex("a"), NS.ex("r"), NS.ex("y"), new NamedNode("chrome:theSession")),
                ]);
        });
    });

    // describe("#getResourceProperties", () => {
    //     it("works", () => {
    //         const expected = undefined;
    //         expect(new RDFStore().getResourceProperties())
    //             .toEqual(expected);
    //     });
    // });

    describe("#getResourceProperty", () => {
        it("returns undefined for type statements on unloaded resources", () => {
            const store = new RDFStore();

            expect(store.getResourceProperty(NS.ex("1"), NS.rdf("type")))
                .toBeUndefined();
        });

        it("returns the type for type statements", () => {
            const store = new RDFStore();
            store.addStatements([
                new Statement(NS.ex("2"), NS.rdf("type"), NS.ex("SomeClass")),
            ]);

            expect(store.getResourceProperty(NS.ex("2"), NS.rdf("type")))
                .toEqual(NS.ex("SomeClass"));
        });

        it("returns undefined for other statements on unloaded resources", () => {
            const store = new RDFStore();

            expect(store.getResourceProperty(NS.ex("1"), NS.ex("prop")))
                .toBeUndefined();
        });

        it("returns the object for other statements", () => {
            const store = new RDFStore();
            store.addStatements([
                new Statement(NS.ex("2"), NS.ex("prop"), new Literal("some prop")),
            ]);

            expect(store.getResourceProperty(NS.ex("2"), NS.ex("prop")))
                .toEqual(new Literal("some prop"));
        });

        it("picks the preferred language", () => {
            const store = new RDFStore();
            store.addStatements([
                new Statement(NS.ex("2"), NS.ex("prop"), new Literal("some prop", "de")),
                new Statement(NS.ex("2"), NS.ex("prop"), new Literal("some prop", "nl")),
                new Statement(NS.ex("2"), NS.ex("prop"), new Literal("some prop", "en")),
                new Statement(NS.ex("2"), NS.ex("prop"), new Literal("some prop", "fr")),
            ]);

            expect(store.getResourceProperty(NS.ex("2"), NS.ex("prop")))
                .toEqual(new Literal("some prop", "en"));
        });
    });

    // describe("#statementsFor", () => {
    //     it("works", () => {
    //         const expected = undefined;
    //         expect(new RDFStore().statementsFor())
    //             .toEqual(expected);
    //     });
    // });

    describe("#processTypeStatement", () => {
        it("initializes new resources", () => {
            const store = new RDFStore();

            // @ts-ignore TS-2341
            expect(store.typeCache[NS.ex("1").sI]).toBeUndefined();
            store.addStatements([
                new Statement(NS.ex("1"), NS.rdf("type"), NS.ex("type"), NS.ex("_")),
            ]);
            // @ts-ignore TS-2341
            expect(store.typeCache[NS.ex("1").sI]).toEqual([NS.ex("type")]);
        });

        it("adds new types for cached resources", () => {
            const store = new RDFStore();
            store.addStatements([
                new Statement(NS.ex("1"), NS.rdf("type"), NS.ex("type"), NS.ex("_")),
                new Statement(NS.ex("1"), NS.rdf("type"), NS.ex("type2"), NS.ex("_")),
            ]);

            // @ts-ignore TS-2341
            expect(store.typeCache[NS.ex("1").sI]).toEqual([NS.ex("type"), NS.ex("type2")]);
        });

        it("removes type statements after they are removed from the store", () => {
            const store = new RDFStore();
            store.addStatements([
                new Statement(NS.ex("1"), NS.rdf("type"), NS.ex("type"), NS.ex("_")),
                new Statement(NS.ex("1"), NS.rdf("type"), NS.ex("type2"), NS.ex("_")),
            ]);
            store.removeStatements([new Statement(NS.ex("1"), NS.rdf("type"), NS.ex("type"), NS.ex("_"))]);
            store.flush();

            // @ts-ignore TS-2341
            expect(store.typeCache[NS.ex("1").sI]).toEqual([NS.ex("type2")]);
        });
    });

    describe("#removeResource", () => {
        it("bumps the changeTimestamp", async () => {
            const store = getBasicStore();
            const resource = NS.example("test");
            store.store.addStatements([
                new Statement(resource, NS.rdf("type"), NS.schema("Person")),
            ]);
            store.store.flush();
            const before = store.store.changeTimestamps[resource.sI];

            await new Promise((resolve): void => { window.setTimeout(resolve, 100); });

            store.store.removeResource(resource);
            expect(store.store.changeTimestamps[resource.sI]).toBeGreaterThan(before);
        });

        it("clears the type cache", () => {
            const store = getBasicStore();
            const resource = NS.example("test");
            store.store.addStatements([
                new Statement(resource, NS.rdf("type"), NS.schema("Person")),
            ]);

            expect(store.store.typeCache[resource.sI]).toHaveLength(1);
            store.store.removeResource(resource);
            expect(store.store.typeCache[resource.sI]).toHaveLength(0);
        });

        it("removes the resource data", () => {
            const store = getBasicStore();
            const resource = NS.example("test");
            store.store.addStatements([
                new Statement(resource, NS.rdf("type"), NS.schema("Person")),
                new Statement(resource, NS.schema("name"), new Literal("Name")),
                new Statement(resource, NS.schema("author"), NS.ex("3")),
                new Statement(NS.example("other"), NS.schema("author"), NS.ex("3")),
            ]);

            expect(store.store.statementsFor(resource)).toHaveLength(3);
            store.store.removeResource(resource);
            expect(store.store.statementsFor(resource)).toHaveLength(0);
        });
    });

    describe("#workAvailable", () => {
        it("is zero without work", () => {
            expect(new RDFStore().workAvailable()).toEqual(0);
        });

        it("is more than zero work", () => {
            const store = new RDFStore();
            expect(store.workAvailable()).toEqual(0);
            store.addStatements(thingStatements);
            expect(store.workAvailable()).toEqual(3);
        });

        it("is reset after #flush()", () => {
            const store = new RDFStore();
            store.addStatements(thingStatements);
            expect(store.workAvailable()).toEqual(3);
            store.flush();
            expect(store.workAvailable()).toEqual(0);
        });
    });
});
