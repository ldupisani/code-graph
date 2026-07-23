export abstract class Animal {
    constructor(public readonly name: string) {}

    abstract makeSound(): string;

    describe(): string {
        let i = 40;
        const j = 0;

        i = i + 1 + j;
        return `${this.name} says: ${this.makeSound()}`;
    }
}
