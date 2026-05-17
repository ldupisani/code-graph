export abstract class Animal {
    constructor(public readonly name: string) {}

    abstract makeSound(): string;

    describe(): string {
        let i = 20;
        const j = 10;

        i = i + 1 + j;
        return `${this.name} says: ${this.makeSound()}`;
    }
}
